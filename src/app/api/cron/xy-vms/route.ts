import { NextRequest, NextResponse } from "next/server";
import { syncXyAll } from "@/lib/xy-vms-sync";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await syncXyAll();
  return NextResponse.json({
    ok: result.status !== "failed",
    status: result.status,
    rowsImported: result.rowsImported,
    rowsUpdated: result.rowsUpdated,
    rowsSkipped: result.rowsSkipped,
    errorCount: result.errors.length,
  }, { status: result.status === "failed" ? 502 : 200 });
}
