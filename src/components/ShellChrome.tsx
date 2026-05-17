"use client";

import { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { AppRole } from "@/lib/authz";

type ShellProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

export function ShellChrome({ children, profile }: { children: ReactNode; profile: ShellProfile }) {
  return (
    <div className="app-shell min-h-screen bg-slate-100/70 md:flex">
      <Sidebar role={profile.role} />
      <div className="min-w-0 flex-1">
        <Topbar profile={profile} />
        <main className="mx-auto max-w-7xl p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
