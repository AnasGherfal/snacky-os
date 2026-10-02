const UNIT_COST_DECIMALS = 4;

function roundTo(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function purchaseLineTotalReconciles({
  units,
  unitCost,
  lineTotal,
}: {
  units: number;
  unitCost: number;
  lineTotal: number;
}) {
  if (
    !Number.isFinite(units) ||
    units <= 0 ||
    !Number.isFinite(unitCost) ||
    unitCost < 0 ||
    !Number.isFinite(lineTotal) ||
    lineTotal < 0
  ) {
    return false;
  }

  // Purchase unit cost is stored to four decimals while supplier line totals
  // are stored to two. Compare the stored cost with the cost implied by the
  // supplier total so harmless precision drift (for example 250 / 600) does
  // not lock an otherwise valid received purchase.
  return roundTo(unitCost, UNIT_COST_DECIMALS) === roundTo(lineTotal / units, UNIT_COST_DECIMALS);
}
