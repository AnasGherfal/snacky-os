type RelationRecord<T extends Record<string, unknown>> = T | T[] | null | undefined;

type SiteLike = {
  name?: unknown;
  site_name?: unknown;
  area?: unknown;
  city?: unknown;
};

type MachineLike = {
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

export function machineBaseLabel(value: Pick<MachineLike, "machine_display_name" | "machine_code" | "name">) {
  return textValue(value.machine_display_name) ?? textValue(value.machine_code) ?? textValue(value.name) ?? "Unknown machine";
}

export function machineSiteLabel(
  value: Pick<MachineLike, "location_name" | "location" | "locations">,
  {
    includeArea = true,
    fallback = "بدون موقع",
  }: {
    includeArea?: boolean;
    fallback?: string;
  } = {},
) {
  return (
    textValue(value.location_name)
    ?? formatSiteLabel(value.location ?? value.locations ?? null, { includeArea, fallback })
  );
}

export function formatMachineDisplayName(
  value: MachineLike,
  {
    includeArea = true,
    fallbackSite = "بدون موقع",
  }: {
    includeArea?: boolean;
    fallbackSite?: string;
  } = {},
) {
  return `${machineBaseLabel(value)} — ${machineSiteLabel(value, { includeArea, fallback: fallbackSite })}`;
}
