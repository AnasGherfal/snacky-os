import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ensureFreshXyRoutePlanningData } from "@/lib/xy-vms-sync";

export const dynamic = "force-dynamic";

// The plaintext scheduler token lives only in Supabase Vault. Keeping only its
// SHA-256 digest in source lets pg_cron authenticate without adding another
// plaintext secret to Vercel or GitHub.
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

async function refreshXy(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await ensureFreshXyRoutePlanningData();
    const status = result.outcome === "in_progress"
      ? 202
      : result.outcome === "failed"
        ? 502
        : result.outcome === "unavailable"
          ? 503
          : 200;
    return NextResponse.json({
      ok: status < 400,
      outcome: result.outcome,
      refreshed: result.refreshed,
      skipped: result.skipped,
      results: result.results,
    }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[xy-cron] Automatic XY refresh failed.", error);
    return NextResponse.json({ ok: false, outcome: "failed", error: "Automatic XY refresh failed." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = refreshXy;
export const POST = refreshXy;
