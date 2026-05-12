import Link from "next/link";
import { ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionCard({ children }: { children: ReactNode }) { return <section className="surface-card">{children}</section>; }
export function FormSection({ title, children }: { title: string; children: ReactNode }) { return <section className="surface-card space-y-4"><h2 className="text-base font-semibold">{title}</h2>{children}</section>; }

export function PrimaryButton({ children, href, type = "submit" }: { children: ReactNode; href?: string; type?: "submit" | "button" }) {
  if (href) return <Link className="btn-primary" href={href}>{children}</Link>;
  return <button type={type} className="btn-primary">{children}</button>;
}
export function SecondaryButton({ children, type = "submit" }: { children: ReactNode; type?: "submit" | "button" }) { return <button type={type} className="btn-secondary">{children}</button>; }
export function DangerButton({ children, type = "submit" }: { children: ReactNode; type?: "submit" | "button" }) { return <button type={type} className="btn-danger">{children}</button>; }

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const value = (status ?? "unknown").toString().toLowerCase();
  const tone = value.includes("critical") || value.includes("open") || value.includes("error") ? "danger" : value.includes("progress") || value.includes("review") ? "warn" : value.includes("active") || value.includes("resolved") || value.includes("confirmed") ? "ok" : "neutral";
  return <span className={`status-badge status-${tone}`}>{status ?? "Unknown"}</span>;
}

export function LoadingState({ label = "Loading..." }: { label?: string }) { return <div className="surface-card text-sm text-slate-500">{label}</div>; }

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <div className="table-wrap"><table className="data-table"><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
