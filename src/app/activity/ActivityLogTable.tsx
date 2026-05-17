"use client";

import { useState } from "react";
import { DataTable, StatusBadge } from "@/components/ui";

type ActivityRow = {
  id: string;
  created_at: string;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  summary: string | null;
  before_data: unknown;
  after_data: unknown;
  metadata: unknown;
  actor?: { full_name?: string | null } | null;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function prettyJson(value: unknown) {
  if (!value) return "-";
  return JSON.stringify(value, null, 2);
}

export function ActivityLogTable({ rows }: { rows: ActivityRow[] }) {
  const [selectedRow, setSelectedRow] = useState<ActivityRow | null>(null);

  return (
    <>
      <DataTable headers={["Date / Time", "User", "Role", "Action", "Entity type", "Entity label", "Summary", "Details"]}>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{formatDate(row.created_at)}</td>
            <td>{row.actor?.full_name ?? row.actor_name ?? "-"}</td>
            <td>{row.actor_role ? <StatusBadge status={row.actor_role} /> : "-"}</td>
            <td><StatusBadge status={String(row.action).replaceAll("_", " ")} /></td>
            <td>{String(row.entity_type).replaceAll("_", " ")}</td>
            <td>
              <div>{row.entity_label ?? "-"}</div>
              {row.entity_id ? <div className="text-xs text-slate-500">{String(row.entity_id).slice(0, 8)}</div> : null}
            </td>
            <td>{row.summary ?? "-"}</td>
            <td>
              <button type="button" className="btn-secondary" onClick={() => setSelectedRow(row)}>
                View details
              </button>
            </td>
          </tr>
        ))}
      </DataTable>

      {selectedRow ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-4 sm:items-center" role="dialog" aria-modal="true">
          <div className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Activity details</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {formatDate(selectedRow.created_at)} - {selectedRow.action.replaceAll("_", " ")} - {selectedRow.entity_type.replaceAll("_", " ")}
                </p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setSelectedRow(null)}>
                Close
              </button>
            </div>
            <div className="grid max-h-[70vh] gap-4 overflow-auto p-5 lg:grid-cols-3">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">Before data</h3>
                <pre className="min-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{prettyJson(selectedRow.before_data)}</pre>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">After data</h3>
                <pre className="min-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{prettyJson(selectedRow.after_data)}</pre>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">Metadata</h3>
                <pre className="min-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{prettyJson(selectedRow.metadata)}</pre>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
