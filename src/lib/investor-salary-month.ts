/**
 * Investor salary expense follows the documented month worked, not the date
 * cash left Snacky. Cash outflow reporting itself stays on the payment date.
 * Untagged payments are NOT silently reassigned.
 */
export function salaryCashBelongsToAnotherMonth(
  entry:{metadata?:{service_month?:unknown}|null},
  month:string|undefined,
  categoryKey:string,
):boolean {
  const tagged=entry.metadata?.service_month;
  return Boolean(
    month && categoryKey==="salary"
    && typeof tagged==="string"
    && /^\\d{4}-(0[1-9]|1[0-2])$/.test(tagged)
    && tagged!==month
  );
}
