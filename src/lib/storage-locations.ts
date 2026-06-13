export const storageLocationTypes = ["main_storage", "operator_bag", "vehicle", "damaged", "expired", "temporary", "other"] as const;

export type StorageLocationType = (typeof storageLocationTypes)[number];

export type StorageLocationRow = {
  id: string;
  name: string;
  address: string | null;
  active: boolean;
  location_type: StorageLocationType | string | null;
  related_operator_id: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type InventoryLocationRow = {
  product_id: string;
  product_name?: string | null;
  location_type: string | null;
  location_id: string | null;
  location_name?: string | null;
  quantity_on_hand: number | string | null;
};

export type InventoryMovementLocationRow = {
  id?: string;
  from_entity_type: string | null;
  from_entity_id: string | null;
  to_entity_type: string | null;
  to_entity_id: string | null;
  reason?: string | null;
  created_at?: string | null;
};

export const storageLocationTypeLabels: Record<StorageLocationType, string> = {
  main_storage: "Main Storage",
  operator_bag: "Operator Bag",
  vehicle: "Vehicle",
  damaged: "Damaged",
  expired: "Expired",
  temporary: "Temporary",
  other: "Other",
};

export const storageLocationTypeHelpers = [
  { title: "Main Storage", body: "main warehouse/storage." },
  { title: "Operator Bag", body: "stock assigned to an operator for a route." },
  { title: "Damaged/Expired", body: "stock removed from sellable inventory." },
];

export function normalizeStorageLocationType(value: FormDataEntryValue | string | null | undefined): StorageLocationType {
  const raw = String(value ?? "main_storage");
  return storageLocationTypes.includes(raw as StorageLocationType) ? (raw as StorageLocationType) : "main_storage";
}

export function storageLocationTypeLabel(value: string | null | undefined) {
  const type = normalizeStorageLocationType(value);
  return storageLocationTypeLabels[type];
}

export function storageLocationStatusLabel(active: boolean | null | undefined) {
  return active === false ? "Archived" : "Active";
}

export function storageLocationLedgerTarget(location: Pick<StorageLocationRow, "id" | "location_type" | "related_operator_id">) {
  const type = normalizeStorageLocationType(location.location_type);
  if (type === "operator_bag") {
    return location.related_operator_id ? { entityType: "operator_bag", entityId: location.related_operator_id } : null;
  }
  if (type === "damaged" || type === "expired") {
    return { entityType: "waste", entityId: null };
  }
  return { entityType: "storage", entityId: location.id };
}

export function inventoryRowBelongsToLocation(row: InventoryLocationRow, location: StorageLocationRow) {
  const type = normalizeStorageLocationType(location.location_type);
  if (type === "operator_bag") {
    return Boolean(location.related_operator_id) && row.location_type === "operator_bag" && row.location_id === location.related_operator_id;
  }
  if (type === "damaged" || type === "expired") return false;
  return row.location_type === "storage" && row.location_id === location.id;
}

export function movementBelongsToLocation(movement: InventoryMovementLocationRow, location: StorageLocationRow) {
  const type = normalizeStorageLocationType(location.location_type);
  if (type === "operator_bag") {
    if (!location.related_operator_id) return false;
    return (
      (movement.from_entity_type === "operator_bag" && movement.from_entity_id === location.related_operator_id) ||
      (movement.to_entity_type === "operator_bag" && movement.to_entity_id === location.related_operator_id)
    );
  }
  if (type === "damaged") return movement.reason === "damaged";
  if (type === "expired") return movement.reason === "expired";
  return (
    (movement.from_entity_type === "storage" && movement.from_entity_id === location.id) ||
    (movement.to_entity_type === "storage" && movement.to_entity_id === location.id)
  );
}

export function summarizeStorageLocation(location: StorageLocationRow, inventoryRows: InventoryLocationRow[], movements: InventoryMovementLocationRow[]) {
  const locationInventory = inventoryRows.filter((row) => inventoryRowBelongsToLocation(row, location));
  const productCount = locationInventory.filter((row) => Number(row.quantity_on_hand ?? 0) !== 0).length;
  const totalUnits = locationInventory.reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
  const locationMovements = movements.filter((movement) => movementBelongsToLocation(movement, location));
  const lastMovementAt = locationMovements
    .map((movement) => movement.created_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    productCount,
    totalUnits,
    movementCount: locationMovements.length,
    lastMovementAt,
  };
}
