import { formatMachineDisplayName } from "./machine-site-display.ts";

type RelationRecord<T extends Record<string, unknown>> = T | T[] | null | undefined;

type RouteLike = {
  id?: string | null;
  route_date?: string | null;
  operator_id?: string | null;
  operator?: RelationRecord<{ full_name?: string | null }>;
};

type PurchaseLike = {
  id?: string | null;
  receipt_number?: string | null;
  order_date?: string | null;
  supplier?: RelationRecord<{ name?: string | null }>;
};

type MachineLike = {
  id?: string | null;
  name?: string | null;
  machine_code?: string | null;
  location?: RelationRecord<{ id?: string | null; name?: string | null }>;
};

type StorageLike = {
  id?: string | null;
  name?: string | null;
  location_type?: string | null;
};

type TeamMemberLike = {
  id?: string | null;
  full_name?: string | null;
};

type PickupBatchLike = {
  id?: string | null;
  route_id?: string | null;
  route?: RelationRecord<RouteLike>;
  confirmed_at?: string | null;
  status?: string | null;
};

export type ProductHistoryLookups = {
  routes: Map<string, RouteLike>;
  purchases: Map<string, PurchaseLike>;
  machines: Map<string, MachineLike>;
  storages: Map<string, StorageLike>;
  teamMembers: Map<string, TeamMemberLike>;
  batches: Map<string, PickupBatchLike>;
  suppliers: Map<string, { id?: string | null; name?: string | null }>;
};

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function textValue(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function relationRecord<T extends Record<string, unknown>>(value: RelationRecord<T>) {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

export function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "-";
}

function teamMemberName(member: TeamMemberLike | null | undefined) {
  return textValue(member?.full_name) ?? null;
}

function operatorBagReference(id: string, lookups: ProductHistoryLookups) {
  const operatorName = teamMemberName(lookups.teamMembers.get(id));
  return operatorName ? `${operatorName}'s operator bag` : `Operator bag ${shortId(id)}`;
}

export function formatRouteReference(route: RouteLike | null | undefined, fallbackId?: string | null) {
  const routeDate = textValue(route?.route_date);
  const operatorName = teamMemberName(relationRecord(route?.operator)) ?? null;

  const parts: string[] = [];
  if (routeDate) parts.push(`Route ${routeDate}`);
  else if (fallbackId) parts.push(`Route ${shortId(fallbackId)}`);

  if (operatorName) parts.push(operatorName);

  return parts.length ? parts.join(" · ") : `Route ${shortId(fallbackId)}`;
}

export function formatPurchaseReference(purchase: PurchaseLike | null | undefined, fallbackId?: string | null) {
  const receiptNumber = textValue(purchase?.receipt_number);
  const orderDate = textValue(purchase?.order_date);
  const supplierName = textValue(relationRecord(purchase?.supplier)?.name);

  const parts: string[] = [];
  if (receiptNumber) parts.push(`Purchase ${receiptNumber}`);
  else if (orderDate) parts.push(`Purchase ${orderDate}`);
  else if (fallbackId) parts.push(`Purchase ${shortId(fallbackId)}`);

  if (supplierName) parts.push(supplierName);

  return parts.length ? parts.join(" · ") : `Purchase ${shortId(fallbackId)}`;
}

export function formatPickupBatchReference(batch: PickupBatchLike | null | undefined, lookups: Pick<ProductHistoryLookups, "routes">, fallbackId?: string | null) {
  const route = batch?.route_id ? lookups.routes.get(batch.route_id) ?? relationRecord(batch?.route) : relationRecord(batch?.route);
  return `Pickup batch for ${formatRouteReference(route ?? null, batch?.route_id ?? fallbackId ?? batch?.id ?? null)}`;
}

export function formatHistoryEntityLabel(
  type: string | null | undefined,
  id: string | null | undefined,
  lookups: ProductHistoryLookups,
) {
  if (!type) return "-";
  const entityType = String(type).toLowerCase();
  const fallback = id ? shortId(id) : "-";

  if (!id) {
    if (entityType === "supplier") return "Supplier";
    if (entityType === "adjustment") return "Adjustment";
    return entityType.replaceAll("_", " ");
  }

  if (entityType === "operator_bag") {
    return operatorBagReference(id, lookups);
  }

  if (entityType === "machine") {
    const machine = lookups.machines.get(id);
    return machine ? formatMachineDisplayName(machine as any, { includeArea: true, fallbackSite: `Machine ${shortId(id)}` }) : `Machine ${shortId(id)}`;
  }

  if (entityType === "machine_storage") {
    const machine = lookups.machines.get(id);
    return machine ? `Machine storage: ${formatMachineDisplayName(machine as any, { includeArea: true, fallbackSite: `Machine ${shortId(id)}` })}` : `Machine storage ${shortId(id)}`;
  }

  if (entityType === "storage") {
    const storage = lookups.storages.get(id);
    if (!storage) return `Storage ${shortId(id)}`;
    if (String(storage.location_type ?? "").toLowerCase() === "main_storage") return "Main storage";
    return textValue(storage.name) ?? `Storage ${shortId(id)}`;
  }

  if (entityType === "route") {
    const route = lookups.routes.get(id);
    return formatRouteReference(route ?? null, id);
  }

  if (entityType === "purchase") {
    const purchase = lookups.purchases.get(id);
    return formatPurchaseReference(purchase ?? null, id);
  }

  if (entityType === "supplier") return "Supplier";
  if (entityType === "adjustment") return "Adjustment";

  return `${entityType.replaceAll("_", " ")} ${fallback}`;
}

export function formatHistoryRelatedReferences(
  row: {
    related_route_id?: string | null;
    related_purchase_id?: string | null;
    related_machine_id?: string | null;
    related_pickup_batch_id?: string | null;
  },
  lookups: ProductHistoryLookups,
) {
  const items: { href?: string; label: string }[] = [];

  if (row.related_route_id) {
    items.push({
      href: `/routes/${row.related_route_id}`,
      label: formatRouteReference(lookups.routes.get(row.related_route_id) ?? null, row.related_route_id),
    });
  }

  if (row.related_purchase_id) {
    items.push({
      href: `/purchases/${row.related_purchase_id}`,
      label: formatPurchaseReference(lookups.purchases.get(row.related_purchase_id) ?? null, row.related_purchase_id),
    });
  }

  if (row.related_machine_id) {
    const machine = lookups.machines.get(row.related_machine_id);
    items.push({
      href: machine ? `/machines/${row.related_machine_id}/edit` : undefined,
      label: machine
        ? formatMachineDisplayName(machine as any, { includeArea: true, fallbackSite: `Machine ${shortId(row.related_machine_id)}` })
        : `Machine ${shortId(row.related_machine_id)}`,
    });
  }

  if (row.related_pickup_batch_id) {
    items.push({
      label: formatPickupBatchReference(
        lookups.batches.get(row.related_pickup_batch_id) ?? { id: row.related_pickup_batch_id, route_id: row.related_route_id ?? null },
        lookups,
        row.related_pickup_batch_id,
      ),
    });
  }

  return items;
}

function genericReferenceLabel(id: string, lookups: ProductHistoryLookups) {
  const route = lookups.routes.get(id);
  if (route) return formatRouteReference(route, id);

  const purchase = lookups.purchases.get(id);
  if (purchase) return formatPurchaseReference(purchase, id);

  const machine = lookups.machines.get(id);
  if (machine) {
    return formatMachineDisplayName(machine as any, { includeArea: true, fallbackSite: `Machine ${shortId(id)}` });
  }

  const storage = lookups.storages.get(id);
  if (storage) {
    return String(storage.location_type ?? "").toLowerCase() === "main_storage"
      ? "Main storage"
      : textValue(storage.name) ?? `Storage ${shortId(id)}`;
  }

  const teamMember = lookups.teamMembers.get(id);
  if (teamMember) return teamMemberName(teamMember) ?? shortId(id);

  const batch = lookups.batches.get(id);
  if (batch) return formatPickupBatchReference(batch ?? null, lookups, id);

  if (lookups.suppliers.get(id)) return "Supplier";

  return shortId(id);
}

export function sanitizeHistoryNotes(notes: string | null | undefined, lookups: ProductHistoryLookups) {
  const value = String(notes ?? "").trim();
  if (!value) return "-";

  const prefixReplacements: Array<{ pattern: RegExp; transform: (id: string) => string }> = [
    { pattern: /\bpickup batch\s+([0-9a-f-]{36})\b/gi, transform: (id) => formatPickupBatchReference(lookups.batches.get(id) ?? { id }, lookups, id) },
    { pattern: /\bbatch\s+([0-9a-f-]{36})\b/gi, transform: (id) => formatPickupBatchReference(lookups.batches.get(id) ?? { id }, lookups, id) },
    { pattern: /\broute\s+([0-9a-f-]{36})\b/gi, transform: (id) => formatRouteReference(lookups.routes.get(id) ?? null, id) },
    { pattern: /\bpurchase\s+([0-9a-f-]{36})\b/gi, transform: (id) => formatPurchaseReference(lookups.purchases.get(id) ?? null, id) },
    { pattern: /\bmachine\s+([0-9a-f-]{36})\b/gi, transform: (id) => genericReferenceLabel(id, lookups) },
    { pattern: /\bstorage\s+([0-9a-f-]{36})\b/gi, transform: (id) => genericReferenceLabel(id, lookups) },
    { pattern: /\boperator bag\s+([0-9a-f-]{36})\b/gi, transform: (id) => operatorBagReference(id, lookups) },
  ];

  let output = value;
  for (const { pattern, transform } of prefixReplacements) {
    output = output.replace(pattern, (_, id: string) => transform(id));
  }

  output = output.replace(UUID_PATTERN, (id) => genericReferenceLabel(id, lookups));
  return output;
}
