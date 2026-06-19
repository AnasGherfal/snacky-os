import type { ReactNode } from "react";

type AdminTechnicalDetailsProps = {
  canView: boolean;
  title?: string;
  summary?: string;
  children: ReactNode;
  className?: string;
};

export function AdminTechnicalDetails({
  canView,
  title = "Technical details",
  summary,
  children,
  className = "",
}: AdminTechnicalDetailsProps) {
  if (!canView) return null;

  return (
    <details className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`} data-admin-technical-details>
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">{title}</summary>
      {summary ? <p className="mt-3 text-sm leading-6 text-slate-500">{summary}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </details>
  );
}
