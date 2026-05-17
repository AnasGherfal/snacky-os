import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ReactNode } from "react";
import { ShellChrome } from "@/components/ShellChrome";
import { canAccessPath } from "@/lib/authz";
import { getCurrentProfile } from "@/lib/auth";

export async function AppShell({ children }: { children: ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.active_status !== "active") redirect("/unauthorized");

  const headerStore = await headers();
  const pathname = headerStore.get("x-pathname") ?? "/";
  const allowed = canAccessPath(
    {
      id: profile.id,
      role: profile.role,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    },
    pathname,
  );

  if (!allowed) redirect("/unauthorized");

  return <ShellChrome profile={profile}>{children}</ShellChrome>;
}
