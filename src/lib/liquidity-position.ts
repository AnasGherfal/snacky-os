/** Owner-attested physical liquidity. NOT a Finance ledger transaction or income. */
export type LiquidityPosition = {
  cashOnHandLyd: number;
  bankLyd: number;
  custodyLyd: number;
  immediateDebtLyd: number;
  shortTermDebtLyd: number;
};

const round = (value: number) => Math.round(value * 100) / 100;

export function validLyd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= 1_000_000_000 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

export function parseLydInput(value: FormDataEntryValue | null): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount <= 1_000_000_000 ? round(amount) : null;
}

export function calculateLiquidityPosition(position: LiquidityPosition) {
  if (!Object.values(position).every(validLyd)) {
    throw new Error("Every liquidity amount must be a finite nonnegative LYD amount.");
  }
  const directlyAccessible = round(position.cashOnHandLyd + position.bankLyd);
  const physicallyHeldElsewhere = round(position.custodyLyd);
  const totalFundsIncludingCustody = round(directlyAccessible + physicallyHeldElsewhere);
  const totalDebts = round(position.immediateDebtLyd + position.shortTermDebtLyd);
  const afterImmediateDebt = round(directlyAccessible - position.immediateDebtLyd);
  const afterAllDebts = round(directlyAccessible - totalDebts);
  return {
    directlyAccessible,
    physicallyHeldElsewhere,
    totalFundsIncludingCustody,
    totalDebts,
    afterImmediateDebt,
    afterAllDebts,
    afterAllDebtsIncludingCustody: round(totalFundsIncludingCustody - totalDebts),
  };
}

/** An attestation expires after 7 Tripoli calendar days and must not be future dated. */
export function isCurrentLiquidityAttestation(asOfDate: string, todayTripoli: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !/^\d{4}-\d{2}-\d{2}$/.test(todayTripoli)) return false;
  const a = new Date(`${asOfDate}T00:00:00Z`);
  const t = new Date(`${todayTripoli}T00:00:00Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(t.getTime())
    || a.toISOString().slice(0,10) !== asOfDate || t.toISOString().slice(0,10) !== todayTripoli) return false;
  const ageDays = Math.round((t.getTime() - a.getTime()) / 86_400_000);
  return ageDays >= 0 && ageDays <= 7;
}
