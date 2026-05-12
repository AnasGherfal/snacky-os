import { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100/70 md:flex"><Sidebar /><div className="min-w-0 flex-1"><Topbar /><main className="mx-auto max-w-7xl p-4 md:p-8">{children}</main></div></div>;
}
