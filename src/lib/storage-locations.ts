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

export const storageLocationTypeLabels: Record<StorageLocationType, { en: string; ar: string }> = {
  main_storage: { en: "Main Storage", ar: "المخزن الرئيسي" },
  operator_bag: { en: "Operator Bag", ar: "حقيبة المشغل" },
  vehicle: { en: "Vehicle", ar: "مركبة" },
  damaged: { en: "Damaged", ar: "تالف" },
  expired: { en: "Expired", ar: "منتهي الصلاحية" },
  temporary: { en: "Temporary", ar: "مؤقت" },
  other: { en: "Other", ar: "أخرى" },
};

export type StorageLocationHelperCard = {
  title: { en: string; ar: string };
  body: { en: string; ar: string };
};

export const storageLocationTypeHelperCards: StorageLocationHelperCard[] = [
  { title: { en: "Main Storage", ar: "المخزن الرئيسي" }, body: { en: "main warehouse/storage.", ar: "المخزن الرئيسي أو المستودع المركزي." } },
  { title: { en: "Operator Bag", ar: "حقيبة المشغل" }, body: { en: "stock assigned to an operator for a route.", ar: "مخزون مخصص لمشغل أثناء الجولة." } },
  { title: { en: "Damaged/Expired", ar: "تالف / منتهي الصلاحية" }, body: { en: "stock removed from sellable inventory.", ar: "مخزون أُخرج من المخزون القابل للبيع." } },
];

export function normalizeStorageLocationType(value: FormDataEntryValue | string | null | undefined): StorageLocationType {
  const raw = String(value ?? "main_storage");
  return storageLocationTypes.includes(raw as StorageLocationType) ? (raw as StorageLocationType) : "main_storage";
}

export function storageLocationTypeLabel(value: string | null | undefined, locale: "en" | "ar" = "en") {
  const type = normalizeStorageLocationType(value);
  return storageLocationTypeLabels[type][locale];
}

export function storageLocationStatusLabel(active: boolean | null | undefined, locale: "en" | "ar" = "en") {
  if (locale === "ar") return active === false ? "مؤرشف" : "نشط";
  return active === false ? "Archived" : "Active";
}

export function storageLocationHelperTitle(title: string, locale: "en" | "ar" = "en") {
  const entry = storageLocationTypeHelperCards.find((helper) => helper.title.en === title || helper.title.ar === title);
  if (!entry) return title;
  return entry.title[locale];
}

export function storageLocationHelperBody(title: string, body: string, locale: "en" | "ar" = "en") {
  const entry = storageLocationTypeHelperCards.find((helper) => helper.title.en === title || helper.title.ar === title);
  if (!entry) return body;
  return entry.body[locale];
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
