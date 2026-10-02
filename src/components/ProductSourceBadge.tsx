type ProductSourceBadgeProps = {
  source: string | null | undefined;
};

export function productSourceLabel(source: string | null | undefined) {
  const value = String(source ?? "initial_import").toLowerCase();
  if (value === "vms" || value === "vms_import") return "VMS";
  if (value === "latest_purchase" || value === "purchase" || value === "average_cost") return "Purchase";
  if (value === "manual") return "Manual";
  return "Initial import";
}

export function ProductSourceBadge({ source }: ProductSourceBadgeProps) {
  const label = productSourceLabel(source);
  const tone =
    label === "VMS"
      ? "bg-emerald-100 text-emerald-700"
      : label === "Purchase"
        ? "bg-sky-100 text-sky-700"
        : label === "Manual"
          ? "bg-slate-100 text-slate-700"
          : "bg-amber-100 text-amber-700";

  return <span className={`status-badge ${tone}`}>{label}</span>;
}
