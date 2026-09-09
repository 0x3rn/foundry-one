import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@foundry/auth";
import { getDatabaseClient } from "@foundry/database";
import { DashboardShell } from "@/components/dashboard-shell";

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
      projects: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
    },
  });

  return (
    <DashboardShell
      user={{ name: session.user.name, email: session.user.email }}
      workspaceId={workspace?.id}
      projectId={workspace?.projects[0]?.id}
    />
  );
}
