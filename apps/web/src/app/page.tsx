import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@foundry/auth";
import { DashboardShell } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getAuth().api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/login");
  }

  return <DashboardShell user={{ name: session.user.name, email: session.user.email }} />;
}
