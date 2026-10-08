import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { retryPendingStopXyQuantities } from "@/lib/xy-stop-quantity-sync";

export const dynamic = "force-dynamic";
// Same SHA-256 cron token used by the current protected XY VMS scheduler.
// The plaintext credential is kept in Supabase Vault, not source.
const SCHEDULER_SHA256 = "6a8316c2ea6b58c928921ca0c141ff9f683d279eb8e2abbe682c1d7d52167d89";
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const environmentToken = String(process.env.CRON_SECRET ?? "").trim();
  if (!token || !(
    (environmentToken && equal(digest(token), digest(environmentToken)))
    || equal(digest(token), SCHEDULER_SHA256)
  )) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await retryPendingStopXyQuantities();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[cron:xy-stop-quantities] Failed",error);
    return NextResponse.json({ ok: false, error: "Could not process queued XY quantities." }, { status: 503 });
  }
}
export const GET = POST;
