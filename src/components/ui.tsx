import Link from "next/link";
import { ReactNode } from "react";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

function formatDisplayText(value: unknown, fallback: string) {
  if (typeof value === "string") {
    const text = value.trim();
    return text && text !== "[object Object]" ? text : fallback;
  }
  if (value instanceof Error) {
    return formatDisplayText(value.message, fallback);
  }
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function formatStatusLabel(value: string | null | undefined) {
  const raw = formatDisplayText(value, "Unknown");
  return raw
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`))
    .join(" ");
}

function statusTone(status: string | null | undefined) {
  const value = String(status ?? "unknown").toLowerCase();
  const danger = ["critical", "inactive", "void", "cancel", "damaged", "expired", "out_of_stock", "failed", "rejected", "deleted", "delete"];
  const warn = ["review", "pending", "draft", "assigned", "in_progress", "maintenance", "low_stock", "reserved", "partial", "unpaid", "missing"];
  const ok = ["active", "confirmed", "completed", "paid", "received", "available", "resolved", "reviewed", "counted_confirmed", "included", "ok", "complete"];
  if (danger.some((word) => value.includes(word))) return "danger";
  if (warn.some((word) => value.includes(word))) return "warn";
  if (ok.some((word) => value.includes(word))) return "ok";
  return "neutral";
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm text-slate-500">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-slate-300">/</span> : null}
            {item.href && !isLast ? (
              <Link href={item.href} className="font-medium text-slate-600 hover:text-slate-900">
                {item.label}
              </Link>
            ) : (
              <span aria-current={isLast ? "page" : undefined} className={isLast ? "font-medium text-slate-900" : undefined}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function PageHeader({ title, subtitle, action, breadcrumbs }: { title: string; subtitle?: ReactNode; action?: ReactNode; breadcrumbs?: BreadcrumbItem[] }) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <h1 className="break-words text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        {subtitle ? <div className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{subtitle}</div> : null}
      </div>
      {action ? <div className="w-full shrink-0 sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">{action}</div> : null}
    </div>
  );
}
export const SectionCard = ({ children }: { children: ReactNode }) => <section className="surface-card">{children}</section>;
export const FormPageLayout = ({ children }: { children: ReactNode }) => <div className="mx-auto max-w-4xl space-y-5">{children}</div>;
export const FormSection = ({ title, description, children }: { title: string; description?: string; children: ReactNode }) => (
  <section className="surface-card space-y-4">
    <div>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {description ? <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p> : null}
    </div>
    {children}
  </section>
);
export const FormField = ({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) => <label className="block space-y-1.5"><span className="text-sm font-medium text-slate-800">{label}{required ? <span className="text-rose-600"> *</span> : null}</span>{children}{hint ? <span className="block text-xs leading-5 text-slate-500">{hint}</span> : null}</label>;

export function PrimaryButton({ children, href, type = "submit" }: { children: ReactNode; href?: string; type?: "submit" | "button" }) { return href ? <Link className="btn-primary" href={href}>{children}</Link> : <button type={type} className="btn-primary">{children}</button>; }
export const SecondaryButton = ({ children, href, type = "button" }: { children: ReactNode; href?: string; type?: "submit" | "button" }) => href ? <Link href={href} className="btn-secondary">{children}</Link> : <button type={type} className="btn-secondary">{children}</button>;
export const StatusBadge = ({ status }: { status: string | null | undefined }) => <span className={`status-badge status-${statusTone(status)}`}>{formatStatusLabel(status)}</span>;
export const DataTable = ({ headers, children, className = "" }: { headers: string[]; children: ReactNode; className?: string }) => <div className={`table-wrap ${className}`}><table className="data-table"><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
export const MobileCardList = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`grid gap-3 md:hidden ${className}`}>{children}</div>;
export const MobileRecordCard = ({ children, className = "" }: { children: ReactNode; className?: string }) => <article className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</article>;
export const MobileField = ({ label, children }: { label: string; children: ReactNode }) => <div className="min-w-0"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 break-words text-sm text-slate-800">{children}</div></div>;
export const EmptyState = ({ title, body, action }: { title: string; body: unknown; action?: ReactNode }) => <div className="surface-card flex min-h-36 items-center justify-center text-center"><div className="mx-auto max-w-md"><h3 className="text-base font-semibold text-slate-900">{formatDisplayText(title, "Nothing to show yet")}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{formatDisplayText(body, "Create or import records to start using this area.")}</p>{action ? <div className="mt-4">{action}</div> : null}</div></div>;
export const ErrorState = ({ title, body, action }: { title: string; body: unknown; action?: ReactNode }) => <div className="surface-card flex min-h-40 items-center justify-center border-rose-200 bg-white text-center"><div className="mx-auto max-w-md"><div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-sm font-semibold text-rose-700">!</div><h3 className="text-base font-semibold text-slate-950">{formatDisplayText(title, "Something went wrong")}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{formatDisplayText(body, "Snacky OS could not load this information. Please try again or contact an admin.")}</p>{action ? <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">{action}</div> : null}</div></div>;
type LoadingStateVariant = "page" | "dashboard" | "table" | "cards" | "form" | "detail";
const Skeleton = ({ className = "" }: { className?: string }) => <div className={`animate-pulse rounded bg-slate-200/80 ${className}`} />;
const TopProgress = () => <div className="h-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true"><div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--snacky-primary)]" /></div>;
function LoadingHeader() { return <div className="flex items-center justify-between gap-3"><div className="space-y-2"><Skeleton className="h-7 w-56 max-w-full" /><Skeleton className="h-4 w-80 max-w-full bg-slate-200/60" /></div><div className="hidden h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-[var(--snacky-primary)] sm:block" /></div>; }
function StatSkeletons({ count }: { count: number }) { return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: count }).map((_, index) => <div key={index} className="surface-card space-y-3"><Skeleton className="h-3 w-24 bg-slate-200/60" /><Skeleton className="h-8 w-16" /></div>)}</div>; }
function CardSkeletons({ count }: { count: number }) { return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: count }).map((_, index) => <div key={index} className="surface-card space-y-4"><Skeleton className="h-5 w-36" /><Skeleton className="h-4 w-full bg-slate-200/60" /><Skeleton className="h-4 w-2/3 bg-slate-200/60" /><Skeleton className="h-16 w-full bg-slate-100" /></div>)}</div>; }
function TableSkeleton({ rows }: { rows: number }) { return <div className="table-wrap" aria-hidden="true"><table className="data-table"><thead><tr>{["", "", "", ""].map((_, index) => <th key={index}><Skeleton className="h-3 w-20 bg-slate-200/70" /></th>)}</tr></thead><tbody>{Array.from({ length: rows }).map((_, rowIndex) => <tr key={rowIndex}>{["", "", "", ""].map((_, cellIndex) => <td key={cellIndex}><Skeleton className={`h-4 ${cellIndex === 0 ? "w-36" : "w-24"} max-w-full bg-slate-100`} /></td>)}</tr>)}</tbody></table></div>; }
function FormSkeleton({ fields }: { fields: number }) { return <div className="mx-auto max-w-4xl space-y-5"><div className="surface-card space-y-4"><Skeleton className="h-5 w-36" /><div className="grid gap-4 md:grid-cols-2">{Array.from({ length: fields }).map((_, index) => <div key={index} className="space-y-2"><Skeleton className="h-3 w-24 bg-slate-200/60" /><Skeleton className="h-11 w-full" /></div>)}</div></div><div className="flex gap-3"><Skeleton className="h-11 w-28" /><Skeleton className="h-11 w-24 bg-slate-100" /></div></div>; }
function DetailSkeleton() { return <div className="space-y-5"><div className="grid gap-4 lg:grid-cols-3"><div className="surface-card space-y-3 lg:col-span-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-full bg-slate-200/60" /><Skeleton className="h-4 w-3/4 bg-slate-200/60" /><Skeleton className="h-24 w-full bg-slate-100" /></div><div className="surface-card space-y-3"><Skeleton className="h-5 w-32" /><Skeleton className="h-8 w-20" /><Skeleton className="h-4 w-full bg-slate-200/60" /></div></div><TableSkeleton rows={4} /></div>; }
export function LoadingState({ variant = "page", rows = 6, cards = 3, fields = 6 }: { variant?: LoadingStateVariant; rows?: number; cards?: number; fields?: number }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading content</span>
      <TopProgress />
      <LoadingHeader />
      {variant === "dashboard" ? <><StatSkeletons count={4} /><CardSkeletons count={2} /></> : null}
      {variant === "table" ? <TableSkeleton rows={rows} /> : null}
      {variant === "cards" || variant === "page" ? <CardSkeletons count={cards} /> : null}
      {variant === "form" ? <FormSkeleton fields={fields} /> : null}
      {variant === "detail" ? <DetailSkeleton /> : null}
    </div>
  );
}
export const SearchInput = ({ name="q", placeholder="Search...", defaultValue = "" }: { name?: string; placeholder?: string; defaultValue?: string }) => <input name={name} placeholder={placeholder} defaultValue={defaultValue} className="field-input md:w-72" />;
