"use client";

import { ReactNode, useState } from "react";
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="app-shell min-h-screen overflow-x-hidden bg-slate-100/70 md:flex">
      <Sidebar role={profile.role} mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="min-w-0 flex-1">
        <Topbar profile={profile} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
