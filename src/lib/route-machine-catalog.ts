import { formatSiteLabel } from "./machine-site-display.ts";

type RouteMachineSource = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  machine_display_name?: string | null;
  vms_machine_id?: string | null;
  vms_location_name?: string | null;
  vms_raw_metadata?: unknown;
  location?: Record<string, unknown> | Record<string, unknown>[] | null;
};

export type RouteMachineCatalogRow = {
  id: string;
  name: string;
  machine_display_name: string | null;
  machine_code: string;
  location_name: string | null;
};

function cleanText(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (["unknown", "unknown machine", "unknown location", "no location", "-"].includes(normalized)) return null;
  return text;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function xyMachineName(machine: RouteMachineSource) {
  const metadata = record(machine.vms_raw_metadata);
  const raw = record(metadata?.raw);
  return cleanText(raw?.jqmc) ?? cleanText(metadata?.jqmc);
}

export function buildRouteMachineCatalog(machines: RouteMachineSource[]): RouteMachineCatalogRow[] {
  return machines.map((machine) => {
    const location = Array.isArray(machine.location) ? machine.location[0] : machine.location;
    const machineCode = cleanText(machine.machine_code) ?? cleanText(machine.vms_machine_id) ?? "Machine";
    const displayName = cleanText(machine.machine_display_name);
    const name = displayName ?? cleanText(machine.name) ?? xyMachineName(machine) ?? machineCode;
    const locationName = cleanText(formatSiteLabel(location ?? null, { includeArea: true, fallback: "" }))
      ?? cleanText(machine.vms_location_name);

    return {
      id: machine.id,
      name,
      machine_display_name: displayName,
      machine_code: machineCode,
      location_name: locationName,
    };
  });
}
