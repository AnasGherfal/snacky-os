import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { discoverXyDashboardSalesApi } from "@/lib/xy-dashboard-discovery";

export const dynamic = "force-dynamic";

const SUPABASE_SCHEDULER_TOKEN_SHA256 = "6a8316c2ea6b58c928921ca0c141ff9f683d279eb8e2abbe682c1d7d52167d89";

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function authorized(request: NextRequest) {
  const authorization = String(request.headers.get("authorization") || "");
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!token) return false;

  const digest = sha256(token);
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (secret && safeEqual(digest, sha256(secret))) return true;
  return safeEqual(digest, SUPABASE_SCHEDULER_TOKEN_SHA256);
}

async function discover(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await discoverXyDashboardSalesApi();
    return NextResponse.json({
      ok: true,
      runId: result.runId,
      filesScanned: result.filesScanned,
      candidateCount: result.candidates.length,
      errorCount: result.errors.length,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[xy-dashboard-discovery] Asset scan failed", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "XY dashboard discovery failed.",
    }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = discover;
export const POST = discover;
