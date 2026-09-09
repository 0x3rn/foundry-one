import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@foundry/auth";
import { getDatabaseClient } from "@foundry/database";
import { DashboardShell } from "@/components/dashboard-shell";
import type { ControlCenterData } from "@/lib/control-center";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getAuth().api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/login");
  }

  const workspace = await getDatabaseClient().workspace.findFirst({
    where: { members: { some: { userId: session.user.id } } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      projects: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          environment: true,
          createdAt: true,
          providerConnections: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              name: true,
              provider: true,
              status: true,
              capabilities: true,
              lastCheckedAt: true,
            },
          },
          metricSnapshots: {
            orderBy: { capturedAt: "desc" },
            take: 50,
            select: { metricName: true, value: true, unit: true, capturedAt: true },
          },
          securityFindings: {
            orderBy: { lastSeenAt: "desc" },
            take: 20,
            select: { id: true, title: true, severity: true, state: true, lastSeenAt: true },
          },
        },
      },
      auditLogs: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          projectId: true,
          action: true,
          resourceType: true,
          result: true,
          createdAt: true,
        },
      },
    },
  });

  const controlCenter: ControlCenterData = {
    workspace: { id: workspace?.id ?? "", name: workspace?.name ?? "Personal workspace" },
    projects: (workspace?.projects ?? []).map((project) => ({
      id: project.id,
      name: project.name,
      environment: project.environment,
      createdAt: project.createdAt.toISOString(),
      connections: project.providerConnections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        status: connection.status,
        ...(connection.capabilities && typeof connection.capabilities === "object"
          ? {
              capabilities:
                connection.capabilities as unknown as ControlCenterData["projects"][number]["connections"][number]["capabilities"],
            }
          : {}),
        ...(connection.lastCheckedAt
          ? { lastCheckedAt: connection.lastCheckedAt.toISOString() }
          : {}),
      })),
      metrics: project.metricSnapshots.map((metric) => ({
        name: metric.metricName,
        value: Number(metric.value),
        ...(metric.unit ? { unit: metric.unit } : {}),
        capturedAt: metric.capturedAt.toISOString(),
      })),
      findings: project.securityFindings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        state: finding.state,
        lastSeenAt: finding.lastSeenAt.toISOString(),
      })),
    })),
    activity: (workspace?.auditLogs ?? []).map((event) => ({
      id: event.id,
      ...(event.projectId ? { projectId: event.projectId } : {}),
      action: event.action,
      resourceType: event.resourceType,
      result: event.result,
      createdAt: event.createdAt.toISOString(),
    })),
  };

  return (
    <DashboardShell
      user={{ name: session.user.name, email: session.user.email }}
      workspaceId={workspace?.id}
      projectId={workspace?.projects[0]?.id}
      controlCenter={controlCenter}
    />
  );
}
