import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { probeXySalesAuthBridge } from "@/lib/xy-auth-bridge";

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

function bearerToken(request: NextRequest) {
  const authorization = String(request.headers.get("authorization") ?? "");
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function authorized(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return false;
  const digest = sha256(token);
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (secret && safeEqual(digest, sha256(secret))) return true;
  return safeEqual(digest, SUPABASE_SCHEDULER_TOKEN_SHA256);
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await probeXySalesAuthBridge();
    return NextResponse.json({
      ok: Boolean(result.winningMethod),
      runId: result.runId,
      winningMethod: result.winningMethod,
      sessionVerified: result.sessionVerified,
      attempts: result.attempts.map((attempt) => ({
        method: attempt.method,
        endpoint: attempt.endpoint,
        httpStatus: attempt.httpStatus,
        code: attempt.code,
        message: attempt.message,
        rowCount: attempt.rowCount,
        success: attempt.success,
        error: attempt.error,
      })),
    }, {
      status: result.winningMethod ? 200 : 409,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[xy-auth-bridge] Probe failed", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "XY auth bridge probe failed.",
    }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = run;
export const POST = run;
