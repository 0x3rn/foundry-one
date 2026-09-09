import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env as processEnv } from "node:process";

export const CREDENTIAL_ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface CredentialMetadata {
  readonly provider: string;
  readonly connectionId: string;
}

export interface EncryptedEnvelope extends CredentialMetadata {
  readonly algorithm: typeof CREDENTIAL_ALGORITHM;
  readonly keyVersion: number;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

export interface EncryptionKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface EncryptionKeyring {
  readonly current: EncryptionKey;
  readonly keys: readonly EncryptionKey[];
}

type Environment = Readonly<Record<string, string | undefined>>;

export type VaultErrorCode =
  "invalid_key" | "invalid_envelope" | "tampered_ciphertext" | "key_version_unavailable";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new VaultError("invalid_key", "Credential encryption keys must be 32 bytes.");
  }
}

function encodeKey(value: string): Uint8Array {
  const normalized = value.trim();
  const isHex = /^[0-9a-f]{64}$/i.test(normalized);
  const key = Buffer.from(normalized, isHex ? "hex" : "base64url");
  assertKey(key);
  return key;
}

export function createKeyring(
  current: EncryptionKey,
  previous: readonly EncryptionKey[] = [],
): EncryptionKeyring {
  assertKey(current.key);
  const keys = [current, ...previous];
  const versions = new Set<number>();
  for (const item of keys) {
    assertKey(item.key);
    if (!Number.isInteger(item.version) || item.version < 1 || versions.has(item.version)) {
      throw new VaultError(
        "invalid_key",
        "Credential key versions must be unique positive integers.",
      );
    }
    versions.add(item.version);
  }
  return { current, keys };
}

export function createKeyringFromEnvironment(env: Environment = processEnv): EncryptionKeyring {
  const currentVersion = Number(env.FOUNDRY_CREDENTIAL_KEY_VERSION ?? "1");
  const currentValue = env.FOUNDRY_CREDENTIAL_KEY;
  if (!currentValue || !Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new VaultError(
      "invalid_key",
      "FOUNDRY_CREDENTIAL_KEY and a positive key version are required.",
    );
  }

  const previous = (env.FOUNDRY_CREDENTIAL_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1) {
        throw new VaultError(
          "invalid_key",
          "Previous credential keys must use version:key format.",
        );
      }
      return {
        version: Number(entry.slice(0, separator)),
        key: encodeKey(entry.slice(separator + 1)),
      };
    });

  return createKeyring({ version: currentVersion, key: encodeKey(currentValue) }, previous);
}

function associatedData(metadata: CredentialMetadata): Buffer {
  return Buffer.from(
    `${CREDENTIAL_ALGORITHM}:${metadata.provider}:${metadata.connectionId}`,
    "utf8",
  );
}

function assertEnvelope(envelope: EncryptedEnvelope): void {
  if (
    envelope.algorithm !== CREDENTIAL_ALGORITHM ||
    !envelope.provider ||
    !envelope.connectionId ||
    !envelope.iv ||
    !envelope.authTag ||
    !envelope.ciphertext
  ) {
    throw new VaultError("invalid_envelope", "Credential envelope is incomplete.");
  }
}

export class CredentialVault {
  constructor(private readonly keyring: EncryptionKeyring) {}

  encrypt(
    credentials: Readonly<Record<string, string>>,
    metadata: CredentialMetadata,
  ): EncryptedEnvelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CREDENTIAL_ALGORITHM, this.keyring.current.key, iv);
    cipher.setAAD(associatedData(metadata));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);

    return {
      algorithm: CREDENTIAL_ALGORITHM,
      keyVersion: this.keyring.current.version,
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      ...metadata,
    };
  }

  decrypt(envelope: EncryptedEnvelope): Readonly<Record<string, string>> {
    assertEnvelope(envelope);
    const key = this.keyring.keys.find((item) => item.version === envelope.keyVersion);
    if (!key) {
      throw new VaultError(
        "key_version_unavailable",
        "The key version for this credential is not available.",
      );
    }

    try {
      const decipher = createDecipheriv(
        CREDENTIAL_ALGORITHM,
        key.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(associatedData(envelope));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const credentials: unknown = JSON.parse(plaintext);
      if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
        throw new Error("Credential payload must be an object.");
      }
      for (const [name, value] of Object.entries(credentials)) {
        if (typeof value !== "string") {
          throw new Error(`Credential field ${name} must be a string.`);
        }
      }
      return credentials as Record<string, string>;
    } catch (error) {
      if (error instanceof VaultError) {
        throw error;
      }
      throw new VaultError(
        "tampered_ciphertext",
        "Credential decryption failed integrity validation.",
        { cause: error },
      );
    }
  }

  rotate(envelope: EncryptedEnvelope): EncryptedEnvelope {
    const credentials = this.decrypt(envelope);
    return this.encrypt(credentials, {
      provider: envelope.provider,
      connectionId: envelope.connectionId,
    });
  }
}

export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}
