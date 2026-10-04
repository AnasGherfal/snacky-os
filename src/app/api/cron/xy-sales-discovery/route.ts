import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { discoverXySalesEndpoints } from "@/lib/xy-sales-discovery";

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

  const secret = String(process.env.CRON_SECRET ?? "").trim();
  const digest = sha256(token);
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
    const result = await discoverXySalesEndpoints();
    return NextResponse.json({
      ok: true,
      runId: result.runId,
      candidateCount: result.candidateCount,
      probeCount: result.probeCount,
      interestingCount: result.interestingCount,
      bestCandidate: result.bestCandidate ? {
        endpoint: result.bestCandidate.endpoint,
        variant: result.bestCandidate.variant,
        confidence: result.bestCandidate.confidence,
        responseShape: result.bestCandidate.response_shape,
      } : null,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[xy-sales-discovery] Read-only endpoint discovery failed", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "XY sales discovery failed.",
    }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = discover;
export const POST = discover;
