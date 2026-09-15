"use server";

import { revalidatePath } from "next/cache";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { logActivity } from "@/lib/activity-log";
import { validateBusinessRecord, type BusinessRecordKind, type BusinessRecordResult } from "@/lib/business-record-validation";

async function record(kind: BusinessRecordKind, fd: FormData): Promise<BusinessRecordResult> {
  const fail = (message: string, retrySameRequest = false): BusinessRecordResult => ({ ok: false, message, retrySameRequest });
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !profile.team_member_id) return fail("Sign in with an active Snacky account.");
  if (kind === "exchange" ? !hasPermission(profile, "finance.edit") : !hasPermission(profile, "issues.view") || !hasPermission(profile, "issues.create")) return fail("Your role is not allowed to record this entry.");
  const values = Object.fromEntries(Array.from(fd.entries(), ([key, value]) => [key, typeof value === "string" ? value.trim() : ""])) as Record<string, string>;
  const validation = validateBusinessRecord(kind, values);
  if (validation) return fail(validation);
  const token = await getAuthAccessToken();
  const supabase = token ? getSupabaseServerClient(token) : null;
  if (!supabase) return fail("Your session could not be verified. Sign in again.", true);
  const id = values.client_submission_id;
  const rpc = kind === "exchange" ? "snacky_record_currency_exchange_v1" : "snacky_create_customer_issue_v1";
  const payload = kind === "exchange" ? {
    p_client_submission_id: id, p_transaction_date: values.transaction_date,
    p_source_account_id: values.source_account_id, p_destination_account_id: values.destination_account_id,
    p_source_amount: Number(values.source_amount), p_destination_amount: Number(values.destination_amount), p_note: values.note || null,
  } : {
    p_client_submission_id: id, p_machine_id: values.machine_id || null,
    p_issue_type: values.issue_type, p_priority: values.priority,
    p_customer_name: values.customer_name || null, p_customer_phone: values.customer_phone || null,
    p_contact_channel: values.contact_channel, p_description: values.description,
  };
  try {
    const { data, error } = await supabase.rpc(rpc, payload);
    if (error) {
      console.error("[business-record] RPC failed", { kind, id, code: error.code });
      if (["PGRST202", "42883"].includes(error.code)) return fail("This feature's database update is not active yet. Nothing was recorded.");
      if (["23514", "22023", "P0002"].includes(error.code)) return fail(error.message || "Review the details before saving.");
      if (error.code === "42501" || error.code === "28000") return fail("Your session or role is not permitted to record this entry.", true);
      // Reusing a command with other details must never mint a fresh command.
      return fail("The result could not be confirmed. Retry this same saved request; do not create a second entry.", true);
    }
    const result = data as Record<string, unknown> | null;
    if (!result || result.id !== id || (kind === "exchange" && (Number(result.amount) !== Number(values.source_amount) || Number(result.destination_amount) !== Number(values.destination_amount) || result.source_account_id !== values.source_account_id || result.destination_account_id !== values.destination_account_id))) return fail("The saved result could not be verified. Retry this same request.", true);
    if (kind === "exchange" && result.transaction_status !== "active") return fail("This exchange was already recorded and later voided or archived. Review its history before creating another exchange.", true);
    const href = kind === "exchange" ? `/finance/exchange?recorded=${id}` : `/issues?created=${id}`;
    try {
      await logActivity({ profile, idempotencyKey: `business-record:${kind}:${id}`, action: kind === "exchange" ? "currency_exchange" : "create_customer_issue", entityType: kind === "exchange" ? "financial_transaction" : "issue", entityId: id, entityLabel: id.slice(0, 8), afterData: result, summary: kind === "exchange" ? `Recorded ${values.source_amount} LYD → ${values.destination_amount} USD` : "Recorded a customer support issue" });
      for (const path of kind === "exchange" ? ["/finance", "/finance/transactions", "/finance/exchange"] : ["/issues", "/operator/issues"]) revalidatePath(path);
    } catch (error) {
      // The command is already committed; an audit/cache error is not a failed
      // exchange or issue and must not invite duplicate submission.
      console.error("[business-record] Committed entry needs audit/cache follow-up", { kind, id, error });
    }
    return { ok: true, id, href };
  } catch {
    return fail("The connection ended before the result was confirmed. Retry the saved request to avoid a duplicate.", true);
  }
}

export async function recordCurrencyExchange(fd: FormData): Promise<BusinessRecordResult> { return record("exchange", fd); }
export async function createCustomerIssue(fd: FormData): Promise<BusinessRecordResult> { return record("issue", fd); }
