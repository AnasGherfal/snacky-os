import { NextResponse } from "next/server";
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { buyingRoles, buyingSameOrigin } from "@/lib/buying-lists";
import { validateMarketCommand, marketReceiptMatches } from "@/lib/market-checklist";
import { readCompanyBody, CompanyRequestTooLarge } from "@/lib/company-request";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, {
  status,
  headers: { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" },
});

export async function POST(request: Request) {
  if (!buyingSameOrigin(request)) return json({ ok: false, code: "denied", retryable: false }, 403);
  let db: Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>;
  try {
    const profile = await getCurrentProfile();
    if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, buyingRoles)) return json({ ok: false, code: "denied", retryable: false }, 403);
    db = await getAuthenticatedSupabaseServerClient();
  } catch {
    return json({ ok: false, code: "unavailable", retryable: true }, 503);
  }
  if (!db) return json({ ok: false, code: "unavailable", retryable: true }, 503);
  let command;
  try {
    command = validateMarketCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request, 400000))));
  } catch (error) {
    return json({ ok: false, code: "invalid", retryable: false }, error instanceof CompanyRequestTooLarge ? 413 : 400);
  }
  try {
    const { data, error } = await db.rpc("snacky_buying_checklist_command_v1", { p_command: command });
    if (error) {
      const code = error.code === "42501" ? "denied"
        : ["40001", "23505"].includes(error.code) ? "conflict"
          : ["22023", "22P02", "22008", "23514", "23502", "23503", "22003"].includes(error.code) ? "invalid"
            : error.code === "PGRST202" ? "not_installed" : "uncertain";
      console.error("buying-checklist.command", { code: error.code, message: error.message, requestId: command.request_id });
      return json({ ok: false, code, retryable: code === "uncertain" || code === "not_installed" }, code === "denied" ? 403 : code === "conflict" ? 409 : code === "invalid" ? 400 : 503);
    }
    const response = { ...data, ok: true };
    if (!marketReceiptMatches(command, response)) return json({ ok: false, code: "uncertain", retryable: true }, 503);
    return json(response);
  } catch {
    return json({ ok: false, code: "uncertain", retryable: true }, 503);
  }
}
