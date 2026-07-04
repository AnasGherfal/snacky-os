export type InventoryEntityType = "storage" | "operator_bag" | "machine" | "machine_storage" | "waste" | "adjustment";

export type InventoryMovementOption = {
  value: string;
  label: string;
  helper: string;
  dbReason: string;
  availableInForm: boolean;
};

export const INVENTORY_MOVEMENT_OPTIONS: InventoryMovementOption[] = [
  {
    value: "purchase_received",
    label: "Purchase received",
    helper: "Record supplier stock received into storage.",
    dbReason: "purchase_received",
    availableInForm: false,
  },
  {
    value: "storage_to_route",
    label: "Storage to route bag",
    helper: "Take stock from storage into the route bag.",
    dbReason: "storage_to_operator_bag",
    availableInForm: true,
  },
  {
    value: "route_to_machine",
    label: "Route bag to machine",
    helper: "Move carried stock from the route bag into a machine.",
    dbReason: "operator_bag_to_machine",
    availableInForm: true,
  },
  {
    value: "route_to_machine_storage",
    label: "Route bag to machine storage",
    helper: "Move extra route stock into machine storage for the next refill.",
    dbReason: "extra_stock_left_at_machine",
    availableInForm: false,
  },
  {
    value: "route_to_storage_return",
    label: "Route bag to storage return",
    helper: "Return unused route stock back to storage.",
    dbReason: "operator_bag_to_storage",
    availableInForm: true,
  },
  {
    value: "machine_to_storage_return",
    label: "Machine to storage return",
    helper: "Move stock from a machine back to storage.",
    dbReason: "machine_to_storage",
    availableInForm: true,
  },
  {
    value: "route_to_damaged",
    label: "Route bag to damaged",
    helper: "Remove damaged route stock to waste.",
    dbReason: "damaged",
    availableInForm: true,
  },
  {
    value: "machine_to_damaged",
    label: "Machine to damaged",
    helper: "Remove damaged machine stock to waste.",
    dbReason: "damaged",
    availableInForm: true,
  },
  {
    value: "manual_adjustment_in",
    label: "Manual adjustment in",
    helper: "Owner/admin correction moving stock into the ledger.",
    dbReason: "manual_correction",
    availableInForm: true,
  },
  {
    value: "manual_adjustment_out",
    label: "Manual adjustment out",
    helper: "Owner/admin correction moving stock out of the ledger.",
    dbReason: "manual_correction",
    availableInForm: true,
  },
  {
    value: "stock_count_correction",
    label: "Stock count correction",
    helper: "Adjust a counted balance back to the ledger.",
    dbReason: "stock_count_adjustment",
    availableInForm: true,
  },
  {
    value: "returned_from_machine",
    label: "Returned from machine",
    helper: "Record product returned from a machine during a route stop.",
    dbReason: "returned_from_machine",
    availableInForm: false,
  },
  {
    value: "expired",
    label: "Expired",
    helper: "Record expired stock moved out of usable inventory.",
    dbReason: "expired",
    availableInForm: false,
  },
  {
    value: "product_substitution",
    label: "Product substitution",
    helper: "Record stock impact from a route substitution.",
    dbReason: "product_substitution",
    availableInForm: false,
  },
  {
    value: "historical_route_deduction",
    label: "Historical route deduction",
    helper: "Backfill an old route deduction that was missed earlier.",
    dbReason: "historical_route_deduction",
    availableInForm: false,
  },
  {
    value: "other",
    label: "Other",
    helper: "Generic inventory movement reason.",
    dbReason: "other",
    availableInForm: false,
  },
];

const movementReasonByValue = new Map(INVENTORY_MOVEMENT_OPTIONS.map((option) => [option.value, option.dbReason]));
const movementLabelByReason = new Map(INVENTORY_MOVEMENT_OPTIONS.map((option) => [option.dbReason, option.label]));

export const INVENTORY_MOVEMENT_FORM_OPTIONS = INVENTORY_MOVEMENT_OPTIONS.filter((option) => option.availableInForm);
export const INVENTORY_MOVEMENT_FILTER_OPTIONS = INVENTORY_MOVEMENT_OPTIONS;

export function normalizeInventoryMovementReason(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return normalized;
  return movementReasonByValue.get(normalized) ?? normalized;
}

export function inventoryMovementReasonLabel(value: string | null | undefined) {
  const normalized = normalizeInventoryMovementReason(value);
  return movementLabelByReason.get(normalized) ?? normalized.replaceAll("_", " ");
}

export function normalizeInventoryEntityType(value: string | null | undefined): InventoryEntityType {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (["storage", "operator_bag", "machine", "machine_storage", "waste", "adjustment"].includes(normalized)) {
    return normalized as InventoryEntityType;
  }
  if (["route", "route_bag", "bag", "operator", "operatorbag"].includes(normalized)) return "operator_bag";
  if (["damaged", "expired", "waste_bin"].includes(normalized)) return "waste";
  return "adjustment";
}

export function inventoryMovementIdempotencyKey(scope: string, ...parts: Array<string | number | null | undefined>) {
  return [scope, ...parts].map((part) => encodeURIComponent(String(part ?? "").trim())).join(":");
}
