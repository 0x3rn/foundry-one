import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import test from "node:test";
import { createDatabaseClient, PrismaProviderConnectionStore } from "@foundry/database";
import {
  createKeyring,
  createKeyringFromEnvironment,
  CredentialVault,
  generateKey,
} from "@foundry/encryption";
import { ProviderConnectionService } from "@foundry/providers-core/connection-service";

if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

test("provider connection store persists ciphertext and supports key rotation", async () => {
  const database = createDatabaseClient();
  const suffix = randomUUID().slice(0, 8);
  const organizationSlug = `credential-test-${suffix}`;
  let organizationId: string | undefined;

  try {
    const organization = await database.organization.create({
      data: { name: "Credential Store Test", slug: organizationSlug },
    });
    organizationId = organization.id;
    const workspace = await database.workspace.create({
      data: {
        organizationId: organization.id,
        name: "Credential Store Test Workspace",
        slug: "credential-test",
      },
    });
    const project = await database.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Credential Store Test Project",
        slug: "credential-test",
      },
    });

    const currentKeyring = createKeyringFromEnvironment();
    const currentVault = new CredentialVault(currentKeyring);
    const store = new PrismaProviderConnectionStore(database);
    const service = new ProviderConnectionService(store, currentVault);
    const secret = `live-test-${suffix}`;
    const publicConnection = await service.create({
      projectId: project.id,
      name: "Primary",
      provider: "supabase",
      credentials: { accessToken: secret },
      managementApiTokenExpiresAt: "2026-12-31T23:59:59.000Z",
    });

    const rawCredential = await database.credential.findUnique({
      where: { providerConnectionId: publicConnection.id },
    });
    assert.ok(rawCredential);
    assert.notEqual(rawCredential.ciphertext, secret);
    assert.equal(JSON.stringify(publicConnection).includes(secret), false);

    const stored = await store.findById(publicConnection.id);
    assert.ok(stored);
    assert.equal(stored.managementApiTokenExpiresAt, "2026-12-31T23:59:59.000Z");
    assert.deepEqual(currentVault.decrypt(stored.credential), { accessToken: secret });

    const rotatedKeyring = createKeyring(
      { version: currentKeyring.current.version + 1, key: Buffer.from(generateKey(), "base64url") },
      currentKeyring.keys,
    );
    const rotatedService = new ProviderConnectionService(
      store,
      new CredentialVault(rotatedKeyring),
    );
    await rotatedService.rotate(publicConnection.id);

    const rotatedCredential = await database.credential.findUnique({
      where: { providerConnectionId: publicConnection.id },
    });
    assert.ok(rotatedCredential);
    assert.equal(rotatedCredential.keyVersion, rotatedKeyring.current.version);
    const rotatedStored = await store.findById(publicConnection.id);
    assert.ok(rotatedStored);
    assert.deepEqual(new CredentialVault(rotatedKeyring).decrypt(rotatedStored.credential), {
      accessToken: secret,
    });

    await service.remove(publicConnection.id);
    assert.equal(await store.findById(publicConnection.id), null);
  } finally {
    if (organizationId) {
      await database.organization.delete({ where: { id: organizationId } });
    }
    await database.$disconnect();
  }
});
