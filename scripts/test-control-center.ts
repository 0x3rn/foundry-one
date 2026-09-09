import assert from "node:assert/strict";
import test from "node:test";
import {
  buildControlCenterSummary,
  formatBytes,
  formatConnectionState,
  getProjectCapabilities,
  type ControlCenterData,
} from "../apps/web/src/lib/control-center.ts";

function baseData(): ControlCenterData {
  return {
    workspace: { id: "workspace-1", name: "Foundry" },
    projects: [],
    activity: [],
  };
}

test("control center treats an empty workspace as awaiting setup", () => {
  const summary = buildControlCenterSummary(baseData());
  assert.equal(summary.health, "awaiting");
  assert.equal(summary.connectedProjects, 0);
  assert.equal(summary.totalProjects, 0);
  assert.equal(summary.openFindings, 0);
});

test("control center summarizes mixed project health without inventing metrics", () => {
  const data: ControlCenterData = {
    ...baseData(),
    projects: [
      {
        id: "project-1",
        name: "Storefront",
        environment: "production",
        createdAt: "2026-09-09T10:00:00.000Z",
        connections: [
          {
            id: "connection-1",
            name: "primary",
            provider: "supabase",
            status: "healthy",
            capabilities: {
              projectMetadata: true,
              relationalDatabase: true,
              documentDatabase: false,
              realtimeDatabase: false,
              sql: true,
              auth: true,
              storage: true,
              functions: false,
              logs: false,
              metrics: false,
              security: false,
            },
          },
        ],
        metrics: [{ name: "auth.users", value: 12, capturedAt: "2026-09-09T11:00:00.000Z" }],
        findings: [
          {
            id: "finding-1",
            title: "RLS missing",
            severity: "high",
            state: "open",
            lastSeenAt: "2026-09-09T11:00:00.000Z",
          },
        ],
      },
      {
        id: "project-2",
        name: "Mobile API",
        environment: "staging",
        createdAt: "2026-09-09T10:05:00.000Z",
        connections: [
          { id: "connection-2", name: "primary", provider: "firebase", status: "disconnected" },
        ],
        metrics: [],
        findings: [],
      },
    ],
    activity: [
      {
        id: "audit-1",
        projectId: "project-2",
        action: "provider_check",
        resourceType: "connection",
        result: "failure",
        createdAt: "2026-09-09T11:05:00.000Z",
      },
    ],
  };

  const summary = buildControlCenterSummary(data);
  assert.equal(summary.totalProjects, 2);
  assert.equal(summary.connectedProjects, 1);
  assert.deepEqual(summary.providerCounts, { supabase: 1, firebase: 1 });
  assert.equal(summary.totalUsers, 12);
  assert.equal(summary.openFindings, 1);
  assert.equal(summary.recentErrors, 1);
  assert.equal(summary.health, "attention");
  assert.equal(getProjectCapabilities(data.projects[0]).authentication, true);
  assert.equal(getProjectCapabilities(data.projects[0]).database, true);
});

test("control center formatting keeps unavailable values explicit", () => {
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatConnectionState("permission_missing"), "Permission gap");
});
