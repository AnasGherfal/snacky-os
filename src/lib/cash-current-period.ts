/**
 * Current operational cash month in Libya. Historical records stay in the ledger,
 * but should not be presented as today's uncounted cash by default.
 */
export function currentLibyaCashMonth(now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not determine the Libya cash month.");
  const startDate = `${year}-${month}-01`;
  return {
    startDate,
    // Libya is UTC+02:00 in this operating period. Use a real offset in
    // timestamptz comparisons rather than interpreting a date as UTC midnight.
    startTimestamp: `${startDate}T00:00:00+02:00`,
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Tripoli", month: "long", year: "numeric",
    }).format(now),
  };
}
