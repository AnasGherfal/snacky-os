type RelationRecord<T extends Record<string, unknown>> = T | T[] | null | undefined;

type SiteLike = {
  name?: unknown;
  site_name?: unknown;
  area?: unknown;
  city?: unknown;
};

type MachineLike = {
  display_name?: unknown;
  machine_code?: unknown;
  machine_display_name?: unknown;
  name?: unknown;
  location_name?: unknown;
  location?: RelationRecord<SiteLike>;
  locations?: RelationRecord<SiteLike>;
};

function textValue(value: unknown) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function relationRecord<T extends Record<string, unknown>>(value: RelationRecord<T>) {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

export function locationSiteName(value: RelationRecord<SiteLike>) {
  const record = relationRecord(value);
  return textValue(record?.site_name) ?? textValue(record?.name);
}

export function locationAreaName(value: RelationRecord<SiteLike>) {
  const record = relationRecord(value);
  return textValue(record?.area);
}

export function formatSiteLabel(
  value: RelationRecord<SiteLike>,
  {
    includeArea = false,
    fallback = "بدون موقع",
  }: {
    includeArea?: boolean;
    fallback?: string;
  } = {},
) {
  const siteName = locationSiteName(value);
  const area = locationAreaName(value);
  if (siteName && area && includeArea && siteName !== area) return `${siteName}, ${area}`;
  return siteName ?? area ?? fallback;
}

export function machineBaseLabel(value: Pick<MachineLike, "display_name" | "machine_display_name" | "machine_code" | "name"> | null | undefined) {
  const machine = value ?? {};
  return textValue(machine.display_name) ?? textValue(machine.machine_display_name) ?? textValue(machine.machine_code) ?? textValue(machine.name) ?? "Unknown machine";
}

export function machineSiteLabel(
  value: Pick<MachineLike, "location_name" | "location" | "locations"> | null | undefined,
  {
    includeArea = true,
    fallback = "بدون موقع",
  }: {
    includeArea?: boolean;
    fallback?: string;
  } = {},
) {
  const machine = value ?? {};
  return (
    textValue(machine.location_name)
    ?? formatSiteLabel(machine.location ?? machine.locations ?? null, { includeArea, fallback })
  );
}

export function formatMachineDisplayName(
  value: MachineLike | null | undefined,
  {
    includeArea = true,
    fallbackSite = "Unknown machine",
  }: {
    includeArea?: boolean;
    fallbackSite?: string;
  } = {},
) {
  const machine = value ?? {};
  const displayName = textValue(machine.display_name) ?? textValue(machine.machine_display_name);
  if (displayName) return displayName;

  const machineCode = textValue(machine.machine_code);
  const siteLabel = textValue(machine.location_name) ?? formatSiteLabel(machine.location ?? machine.locations ?? null, { includeArea, fallback: "" });
  const machineName = textValue(machine.name);

  if (machineCode && siteLabel) return `${machineCode} - ${siteLabel}`;
  if (machineCode && machineName && machineName !== machineCode) return `${machineCode} - ${machineName}`;
  if (machineCode) return machineCode;
  if (machineName) return machineName;
  return "Unknown machine";
}
