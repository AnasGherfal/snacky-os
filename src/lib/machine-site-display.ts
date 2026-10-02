type RelationRecord<T extends Record<string, unknown>> = T | T[] | null | undefined;

type SiteLike = {
  name?: unknown;
  site_name?: unknown;
  location_name?: unknown;
  area?: unknown;
  city?: unknown;
};

type MachineLike = {
  display_name?: unknown;
  machine_display_name?: unknown;
  machine_name?: unknown;
  machine_code?: unknown;
  code?: unknown;
  name?: unknown;
  location_name?: unknown;
  site_name?: unknown;
  area?: unknown;
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
  return textValue(record?.site_name) ?? textValue(record?.location_name) ?? textValue(record?.name);
}

export function locationAreaName(value: RelationRecord<SiteLike>) {
  const record = relationRecord(value);
  return textValue(record?.area) ?? textValue(record?.city);
}

export function formatSiteLabel(
  value: RelationRecord<SiteLike>,
  {
    includeArea = false,
    fallback = "Unknown location",
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

export function machineBaseLabel(
  value: Pick<MachineLike, "display_name" | "machine_display_name" | "machine_name" | "machine_code" | "code" | "name"> | null | undefined,
) {
  const machine = value ?? {};
  return (
    textValue(machine.machine_display_name)
    ?? textValue(machine.machine_name)
    ?? textValue(machine.name)
    ?? textValue(machine.machine_code)
    ?? textValue(machine.code)
    ?? textValue(machine.display_name)
    ?? "Unknown machine"
  );
}

export function machineSiteLabel(
  value: Pick<MachineLike, "location_name" | "site_name" | "area" | "location" | "locations"> | null | undefined,
  {
    includeArea = true,
    fallback = "Unknown location",
  }: {
    includeArea?: boolean;
    fallback?: string;
  } = {},
) {
  const machine = value ?? {};
  return (
    textValue(machine.location_name)
    ?? textValue(machine.site_name)
    ?? textValue(machine.area)
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
  const displayName = (
    textValue(machine.machine_display_name)
    ?? textValue(machine.machine_name)
    ?? textValue(machine.name)
    ?? textValue(machine.display_name)
  );
  const machineCode = textValue(machine.machine_code) ?? textValue(machine.code);
  const siteLabel = machineSiteLabel(machine, { includeArea, fallback: "" });

  if (machineCode && siteLabel) return `${machineCode} - ${siteLabel}`;
  if (displayName && siteLabel && displayName !== siteLabel) return `${displayName} - ${siteLabel}`;
  if (displayName) return displayName;
  if (machineCode) return machineCode;
  return fallbackSite;
}