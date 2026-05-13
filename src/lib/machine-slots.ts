export type MachineSlotPayload = {
  machine_id: string;
  slot_code: string;
  product_id: string;
  capacity: number;
  min_qty: number;
  par_qty: number;
  active: boolean;
};

export function parseMachineSlotForm(fd: FormData): MachineSlotPayload {
  return {
    machine_id: String(fd.get("machine_id") || ""),
    slot_code: String(fd.get("slot_code") || "").trim().toUpperCase(),
    product_id: String(fd.get("product_id") || ""),
    capacity: Number(fd.get("capacity") || 0),
    min_qty: Number(fd.get("min_qty") || 0),
    par_qty: Number(fd.get("par_qty") || 0),
    active: String(fd.get("active") || "true") === "true",
  };
}

export function validateMachineSlot(payload: MachineSlotPayload) {
  if (!payload.machine_id) return "Choose the machine this slot belongs to.";
  if (!payload.slot_code) return "Slot code is required.";
  if (!payload.product_id) return "Product is required.";
  if (payload.capacity <= 0) return "Capacity must be greater than 0.";
  if (payload.min_qty < 0) return "Minimum quantity must be 0 or greater.";
  if (payload.par_qty <= 0) return "Par quantity must be greater than 0.";
  if (payload.min_qty > payload.par_qty) return "Minimum quantity must be less than or equal to par quantity.";
  if (payload.par_qty > payload.capacity) return "Par quantity must be less than or equal to capacity.";
  return null;
}
