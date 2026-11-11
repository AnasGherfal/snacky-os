import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness only: no connection to production systems, business data, or secrets.
// A successful response never implies Supabase/XY readiness or completed cutover.
export function GET() {
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
