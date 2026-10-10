/** Pure client-side fixtures used only by the owner Testing Lab.
 * Never access vendor credentials, database clients or real route data here.
 */
export type TrainingStockSelection = {
  code: string;
  productId: string;
  originalProductId: string;
  initialQty: number;
  actualAdd: number;
  xyQty: number;
  xyProductId: string;
};

export type TrainingXyIssue = {
  slotCode: string;
  reason: "product_mismatch" | "quantity_mismatch";
  expected: number;
  xy: number;
};

export function trainingExpectedFinal(lane: TrainingStockSelection) {
  return (lane.productId === lane.originalProductId ? lane.initialQty : 0) + lane.actualAdd;
}

export function verifyTrainingSelections(lanes: TrainingStockSelection[]): TrainingXyIssue[] {
  const issues: TrainingXyIssue[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!lane.code || seen.has(lane.code)) {
      issues.push({ slotCode: lane.code || "Unknown", reason: "product_mismatch", expected: trainingExpectedFinal(lane), xy: lane.xyQty });
      continue;
    }
    seen.add(lane.code);
    const expected = trainingExpectedFinal(lane);
    if (lane.xyProductId !== lane.productId) {
      issues.push({ slotCode: lane.code, reason: "product_mismatch", expected, xy: lane.xyQty });
    } else if (lane.xyQty !== expected) {
      issues.push({ slotCode: lane.code, reason: "quantity_mismatch", expected, xy: lane.xyQty });
    }
  }
  return issues;
}

export function trainingBagUsed(completedStops: Array<{
  status: string;
  lanes: Array<{ productId: string; actualAdd: number }>;
}>) {
  const result: Record<string, number> = {};
  for (const stop of completedStops) {
    if (stop.status !== "completed") continue;
    for (const line of stop.lanes) {
      result[line.productId] = (result[line.productId] ?? 0) + line.actualAdd;
    }
  }
  return result;
}
