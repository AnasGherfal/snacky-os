import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ensureFreshXyRoutePlanningData, syncXyMachineStatus } from "@/lib/xy-vms-sync";
import { runRefillRouteAutomation } from "@/lib/refill-route-automation";
import { retryPendingXySlotChanges } from "@/lib/xy-pending-slot-changes";
import { scanXyOperationalAlerts } from "@/lib/xy-operational-alerts";

export const dynamic = "force-dynamic";

// The plaintext cron token lives only in Supabase Vault. Keeping only its
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
    // The existing secured ten-minute XY scheduler also retries operator-approved
    // offline product changes. A failure here does not stop normal stock refresh.
    let pendingSlotChanges: unknown = { skipped: true };
    try {
      pendingSlotChanges = await retryPendingXySlotChanges();
    } catch (cause) {
      console.error("[xy-cron] Pending offline lane sync failed", cause);
      pendingSlotChanges = { error: "Pending XY changes could not be checked." };
    }
    const result = await ensureFreshXyRoutePlanningData();
    let machineStatusSync:{status?:string;error?:string;skipped?:boolean;reason?:string}={skipped:true,reason:"Planning refresh still running."};
    if(result.outcome!=="in_progress"){
      try{
        const statusResult=await syncXyMachineStatus();
        machineStatusSync={status:statusResult.status};
      }catch(error){
        console.warn("[xy-cron] Machine status refresh failed; stock refresh result remains valid.",error);
        machineStatusSync={error:error instanceof Error?error.message:"Machine status refresh failed."};
      }
    }
    const automation = ["refreshed", "already_fresh"].includes(result.outcome)
      ? await runRefillRouteAutomation()
      : { skipped: true, reason: `XY planning data is ${result.outcome}.` };

    // In-app owner bell alerts must never block live XY synchronization.
    // This runs with the protected server scheduler, not ChatGPT automations.
    let operationalAlerts: unknown = { unavailable: true };
    try {
      operationalAlerts = await scanXyOperationalAlerts();
    } catch (error) {
      console.error("[xy-cron] In-app XY operational alert scan failed", error);
    }
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
      refillRouteAutomation: automation,
      machineStatusSync,
      pendingSlotChanges,
      operationalAlerts,
    }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // A failed vendor refresh is exactly when the owner needs a durable in-app
    // stale-data alert; the alert check must remain independent of XY success.
    try { await scanXyOperationalAlerts(); }
    catch (alertError) { console.error("[xy-cron] In-app alert scan failed after XY error", alertError); }
    console.error("[xy-cron] Automatic XY refresh failed.", error);
    return NextResponse.json({ ok: false, outcome: "failed", error: "Automatic XY refresh failed." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export const GET = refreshXy;
export const POST = refreshXy;
