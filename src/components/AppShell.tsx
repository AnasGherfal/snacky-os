"use client";

import { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { AppRole, canAccessPath } from "@/lib/authz";

type ShellProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

export function AppShell({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ShellProfile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (cancelled) return;

      if (response.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }

      if (response.status === 403) {
        window.location.href = "/unauthorized";
        return;
      }

      const data = await response.json();
      const loadedProfile = data.profile as ShellProfile;
      const allowed = canAccessPath(
        {
          id: loadedProfile.id,
          role: loadedProfile.role,
          teamMemberId: loadedProfile.team_member_id,
          activeStatus: loadedProfile.active_status,
        },
        window.location.pathname,
      );

      if (!allowed) {
        window.location.href = "/unauthorized";
        return;
      }

      setProfile(loadedProfile);
      setReady(true);
    };

    loadProfile().catch(() => {
      if (!cancelled) window.location.href = "/login";
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">
        Loading...
      </div>
    );
  }

  return <div className="app-shell min-h-screen bg-slate-100/70 md:flex"><Sidebar role={profile.role} /><div className="min-w-0 flex-1"><Topbar profile={profile} /><main className="mx-auto max-w-7xl p-4 md:p-8">{children}</main></div></div>;
}
