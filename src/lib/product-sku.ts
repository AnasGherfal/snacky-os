type ProductSkuSupabase = {
  from: (table: string) => any;
};

const SNACKY_SKU_PREFIX = "SNK-P-";

export function sanitizeProductSku(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function isSkuDuplicateError(error: unknown) {
  const row = error as { code?: string; message?: string } | null | undefined;
  return row?.code === "23505" || String(row?.message ?? "").toLowerCase().includes("sku");
}

async function skuExists(supabase: ProductSkuSupabase, sku: string, excludeProductId?: string | null) {
  let query = supabase.from("products").select("id").eq("sku", sku).limit(1);
  if (excludeProductId) query = query.neq("id", excludeProductId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

async function nextSnackySku(supabase: ProductSkuSupabase) {
  const { data, error } = await supabase.from("products").select("sku").like("sku", `${SNACKY_SKU_PREFIX}%`).limit(5000);
  if (error) throw error;

  const maxNumber = (data ?? []).reduce((max: number, row: { sku?: string | null }) => {
    const match = String(row.sku ?? "").match(/^SNK-P-(\d+)$/);
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);

  for (let next = maxNumber + 1; next < maxNumber + 1000; next += 1) {
    const candidate = `${SNACKY_SKU_PREFIX}${String(next).padStart(4, "0")}`;
    if (!(await skuExists(supabase, candidate))) return candidate;
  }

  return `${SNACKY_SKU_PREFIX}${Date.now().toString().slice(-8)}`;
}

export async function resolveProductSku({
  supabase,
  manualSku,
  vmsProductCode,
  excludeProductId,
}: {
  supabase: ProductSkuSupabase;
  manualSku?: unknown;
  vmsProductCode?: unknown;
  excludeProductId?: string | null;
}) {
  const preferred = sanitizeProductSku(manualSku) || sanitizeProductSku(vmsProductCode);
  const sku = preferred || await nextSnackySku(supabase);
  if (await skuExists(supabase, sku, excludeProductId)) {
    throw new Error(`Product code ${sku} already exists. Use another code or leave it blank to auto-generate.`);
  }
  return sku;
}
