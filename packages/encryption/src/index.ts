export interface EncryptedEnvelope {
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}
