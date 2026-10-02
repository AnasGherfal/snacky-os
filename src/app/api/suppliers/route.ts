import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";

const QUICK_ADD_SUPPLIER_ROLES = ["owner", "admin", "supervisor", "purchasing"] as const;

function normalizeSupplierName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function supplierNameKey(value: unknown) {
  return normalizeSupplierName(value).toLocaleLowerCase();
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !hasAnyRole(profile, QUICK_ADD_SUPPLIER_ROLES)) {
    return NextResponse.json(
      { error: "You do not have permission to add suppliers." },
      { status: 403 },
    );
  }

  const payload = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = normalizeSupplierName(payload?.name);
  if (!name) {
    return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "Supplier name is too long." }, { status: 400 });
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supplier service is unavailable." }, { status: 503 });
  }

  const { data: suppliers, error: loadError } = await supabase
    .from("suppliers")
    .select("id, name")
    .order("created_at", { ascending: true });

  if (loadError) {
    console.error("[api:suppliers] Could not load suppliers before quick add", loadError);
    return NextResponse.json({ error: "Could not check existing suppliers." }, { status: 500 });
  }

  const key = supplierNameKey(name);
  const existing = (suppliers ?? []).find((supplier) => supplierNameKey(supplier.name) === key);
  if (existing) {
    return NextResponse.json({ supplier: existing, created: false });
  }

  const { data: supplier, error } = await supabase
    .from("suppliers")
    .insert({ name })
    .select("id, name")
    .single();

  if (error || !supplier) {
    console.error("[api:suppliers] Could not quick-add supplier", error);
    return NextResponse.json({ error: "Could not add supplier." }, { status: 500 });
  }

  return NextResponse.json({ supplier, created: true }, { status: 201 });
}
