import Link from "next/link";
import { ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
export const SectionCard = ({ children }: { children: ReactNode }) => <section className="surface-card">{children}</section>;
export const FormPageLayout = ({ children }: { children: ReactNode }) => <div className="mx-auto max-w-4xl space-y-5">{children}</div>;
export const FormSection = ({ title, children }: { title: string; children: ReactNode }) => <section className="surface-card space-y-4"><h2 className="text-base font-semibold">{title}</h2>{children}</section>;
export const FormField = ({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) => <label className="block space-y-1"><span className="text-sm font-medium text-slate-800">{label}{required ? <span className="text-rose-600"> *</span> : null}</span>{children}{hint ? <span className="text-xs text-slate-500">{hint}</span> : null}</label>;

export function PrimaryButton({ children, href, type = "submit" }: { children: ReactNode; href?: string; type?: "submit" | "button" }) { return href ? <Link className="btn-primary" href={href}>{children}</Link> : <button type={type} className="btn-primary">{children}</button>; }
export const SecondaryButton = ({ children, href, type = "button" }: { children: ReactNode; href?: string; type?: "submit" | "button" }) => href ? <Link href={href} className="btn-secondary">{children}</Link> : <button type={type} className="btn-secondary">{children}</button>;
export const StatusBadge = ({ status }: { status: string | null | undefined }) => { const v=(status??"unknown").toLowerCase(); const t=v.includes("critical")||v.includes("inactive")?"danger":v.includes("review")||v.includes("maintenance")?"warn":v.includes("active")||v.includes("confirmed")?"ok":"neutral"; return <span className={`status-badge status-${t}`}>{status ?? "Unknown"}</span>; };
export const DataTable = ({ headers, children }: { headers: string[]; children: ReactNode }) => <div className="table-wrap"><table className="data-table"><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
export const EmptyState = ({ title, body }: { title: string; body: string }) => <div className="surface-card text-center"><h3 className="text-base font-semibold">{title}</h3><p className="mt-2 text-sm text-slate-500">{body}</p></div>;
export const SearchInput = ({ name="q", placeholder="Search..." }: { name?: string; placeholder?: string }) => <input name={name} placeholder={placeholder} className="field-input md:w-72" />;
