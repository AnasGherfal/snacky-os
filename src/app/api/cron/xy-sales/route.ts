import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { syncXyLiveSales } from "@/lib/xy-live-sales-sync";

export const dynamic = "force-dynamic";

// Same protected scheduler credential used by the existing XY stock cron.
// Plaintext lives only in Supabase Vault / CRON_SECRET, never in source.
const SUPABASE_SCHEDULER_TOKEN_SHA256 = "6a8316c2ea6b58c928921ca0c141ff9f683d279eb8e2abbe682c1d7d52167d89";

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function bearerToken(request: NextRequest) {
  const authorization = String(request.headers.get("authorization") ?? "");
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function authorized(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return false;

  const secret = String(process.env.CRON_SECRET ?? "").trim();
  const tokenDigest = sha256(token);
  if (secret && safeEqual(tokenDigest, sha256(secret))) return true;

  return safeEqual(tokenDigest, SUPABASE_SCHEDULER_TOKEN_SHA256);
}

async function refreshSales(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await syncXyLiveSales();

    if (result.outcome === "disabled") {
      return NextResponse.json({
        ok: true,
        skipped: true,
        outcome: result.outcome,
        message: result.message,
      }, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const status = result.outcome === "in_progress"
      ? 202
      : result.outcome === "unavailable"
        ? 503
        : result.outcome === "failed"
          ? 502
          : 200;

    return NextResponse.json({
      ok: status < 400,
      ...result,
    }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[xy-sales-cron] Automatic live sales refresh failed.", error);
    return NextResponse.json({
      ok: false,
      outcome: "failed",
      error: "Automatic XY live sales refresh failed.",
    }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = refreshSales;
export const POST = refreshSales;
