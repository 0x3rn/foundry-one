import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { getDatabaseClient } from "@foundry/database";

if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

const baseUrl = process.env.FOUNDRY_TEST_BASE_URL ?? "http://localhost:3000";
const email = `foundry-auth-${randomUUID()}@example.test`;
const workspaceName = `Foundry Auth Test Workspace ${randomUUID().slice(0, 8)}`;
const password = "Foundry-test-password-123!";
let cookie = "";
let userId: string | undefined;
let organizationId: string | undefined;

function updateCookie(response: Response): void {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [];

  if (setCookies.length > 0) {
    cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("origin", baseUrl);

  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (cookie) {
    headers.set("cookie", cookie);
  }

  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers,
  });
  updateCookie(response);
  return response;
}

async function assertStatus(response: Response, expected: number, label: string): Promise<void> {
  assert.equal(response.status, expected, `${label} returned HTTP ${response.status}`);
}

async function run(): Promise<void> {
  const unauthenticated = await request("/api/me");
  await assertStatus(unauthenticated, 401, "unauthenticated session check");

  const landingPage = await request("/");
  await assertStatus(landingPage, 200, "public landing page");
  const landingPageBody = await landingPage.text();
  assert.match(landingPageBody, /A quieter way to run the backend/);
  assert.match(landingPageBody, /Universal control plane/);

  const unauthenticatedPage = await request("/dashboard", { redirect: "manual" });
  assert.ok(
    unauthenticatedPage.status === 307 || unauthenticatedPage.status === 308,
    `protected dashboard should redirect unauthenticated users, received HTTP ${unauthenticatedPage.status}`,
  );
  assert.match(unauthenticatedPage.headers.get("location") ?? "", /\/login$/);

  const registrationPage = await request("/register");
  await assertStatus(registrationPage, 200, "registration page");
  const registrationPageBody = await registrationPage.text();
  assert.match(registrationPageBody, /Create your account/);
  assert.match(registrationPageBody, /Confirm password/);
  assert.match(registrationPageBody, /Show password/);

  const loginPage = await request("/login");
  await assertStatus(loginPage, 200, "login page");
  const loginPageBody = await loginPage.text();
  assert.match(loginPageBody, /Create an account/);
  assert.match(loginPageBody, /Show password/);

  const signUp = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Foundry Auth Test", email, password }),
  });
  await assertStatus(signUp, 200, "registration");
  assert.ok(cookie, "registration should set a session cookie");

  const duplicateSignUp = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Foundry Auth Test", email, password }),
  });
  assert.ok(
    duplicateSignUp.status >= 400 && duplicateSignUp.status < 500,
    `duplicate registration should fail safely, received HTTP ${duplicateSignUp.status}`,
  );

  const sessionAfterRegistration = await request("/api/me");
  await assertStatus(sessionAfterRegistration, 200, "protected session check after registration");
  const sessionBody = (await sessionAfterRegistration.json()) as {
    data: { user: { id: string; email: string } };
  };
  userId = sessionBody.data.user.id;
  assert.equal(sessionBody.data.user.email, email);

  const invalidWorkspace = await request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "   " }),
  });
  await assertStatus(invalidWorkspace, 400, "invalid workspace input");

  const workspaceResponse = await request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: workspaceName }),
  });
  await assertStatus(workspaceResponse, 201, "workspace creation");
  const workspaceBody = (await workspaceResponse.json()) as {
    data: { organizationId: string; workspaceId: string };
  };
  organizationId = workspaceBody.data.organizationId;

  const workspaces = await request("/api/workspaces");
  await assertStatus(workspaces, 200, "workspace listing");
  const workspacesBody = (await workspaces.json()) as {
    data: Array<{ id: string; role: string }>;
  };
  assert.ok(
    workspacesBody.data.some((workspace) => workspace.id === workspaceBody.data.workspaceId),
  );
  assert.equal(
    workspacesBody.data.find((workspace) => workspace.id === workspaceBody.data.workspaceId)?.role,
    "owner",
  );

  const signOut = await request("/api/auth/sign-out", {
    method: "POST",
    body: JSON.stringify({}),
  });
  await assertStatus(signOut, 200, "logout");

  const sessionAfterLogout = await request("/api/me");
  await assertStatus(sessionAfterLogout, 401, "protected session check after logout");

  const invalidSignIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
  assert.ok(
    invalidSignIn.status >= 400 && invalidSignIn.status < 500,
    "invalid login should fail safely",
  );

  const signIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  await assertStatus(signIn, 200, "login");
  assert.ok(cookie, "login should set a session cookie");

  const sessionAfterLogin = await request("/api/me");
  await assertStatus(sessionAfterLogin, 200, "protected session check after login");

  const protectedPage = await request("/dashboard");
  await assertStatus(protectedPage, 200, "protected dashboard page after login");
  const protectedPageBody = await protectedPage.text();
  assert.match(protectedPageBody, /Foundry One/);
  assert.match(protectedPageBody, /Control plane/);

  console.log(
    "Auth flow verified: protected redirect, registration, workspace creation, logout, failed login, login, and dashboard access.",
  );
}

try {
  await run();
} finally {
  const database = getDatabaseClient();

  if (userId) {
    await database.user.delete({ where: { id: userId } });
  }

  if (organizationId) {
    await database.organization.delete({ where: { id: organizationId } });
  }

  await database.$disconnect();
}
