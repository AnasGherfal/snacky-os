"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { parseLydInput } from "@/lib/liquidity-position";

const moneyFields = [
  "cash_on_hand_lyd", "bank_lyd", "custody_lyd",
  "immediate_debt_lyd", "short_term_debt_lyd",
] as const;

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function fail(message: string): never {
  redirect(`/finance/liquidity?error=${encodeURIComponent(message)}`);
}
function details(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length <= 1000 ? text || null : fail("Notes must be at most 1,000 characters.");
}

export async function recordOwnerLiquidityAttestation(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["owner"])) redirect("/unauthorized");
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) fail("The signed-in Finance database session is unavailable.");

  const submissionId = String(formData.get("client_submission_id") ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    fail("Reload Finance and try again; the submission token is invalid.");
  }
  const asOf = String(formData.get("as_of_date") ?? "").trim();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!isValidDate(asOf) || asOf > today) fail("Enter a valid cash-count date that is not in the future.");

  const numbers: Record<string,number> = {};
  for (const name of moneyFields) {
    const amount = parseLydInput(formData.get(name));
    if (amount === null) fail(`Enter a valid, nonnegative LYD amount for ${name}. Do not leave money fields blank.`);
    numbers[name] = amount;
  }

  function optionalDate(name: string): string | null {
    const value = String(formData.get(name) ?? "").trim();
    if (!value) return null;
    if (!isValidDate(value)) fail("One of the repayment dates is invalid.");
    return value;
  }
  const row = {
    client_submission_id: submissionId,
    as_of_date: asOf,
    cash_on_hand_lyd: numbers.cash_on_hand_lyd,
    bank_lyd: numbers.bank_lyd,
    custody_lyd: numbers.custody_lyd,
    immediate_debt_lyd: numbers.immediate_debt_lyd,
    short_term_debt_lyd: numbers.short_term_debt_lyd,
    immediate_debt_due_date: optionalDate("immediate_debt_due_date"),
    short_term_debt_due_date: optionalDate("short_term_debt_due_date"),
    custody_details: details(formData.get("custody_details")),
    debt_details: details(formData.get("debt_details")),
    created_by: profile.id,
  };

  const { error } = await db.from("owner_liquidity_attestations").insert(row);
  if (error) {
    // A double-click / network retry must never generate a second attestation.
    if (error.code !== "23505") fail("Could not save the owner snapshot. No Finance ledger balance was changed.");
    const prior = await db.from("owner_liquidity_attestations")
      .select("id,as_of_date,cash_on_hand_lyd,bank_lyd,custody_lyd,immediate_debt_lyd,short_term_debt_lyd,created_by")
      .eq("client_submission_id", submissionId).maybeSingle();
    const same = !prior.error && prior.data && prior.data.created_by === profile.id
      && prior.data.as_of_date === asOf
      && moneyFields.every(name => Number(prior.data?.[name]) === row[name]);
    if (!same) fail("This submission ID was already used with different figures. Reload and try again.");
  }
  revalidatePath("/finance/liquidity");
  revalidatePath("/finance/growth-decisions");
  redirect("/finance/liquidity?saved=1");
}
