/** UI-only checks aligned with the existing Complete Stop client guards.
 * Stock, proof and cash commit remain authoritative on the server.
 * No additional XY screenshot or manual quantity-save step is introduced.
 */
export type StopReadinessKind = "cleaning" | "photo" | "smart-return" | "smart-xy" | "compressor";
export type StopReadinessStep = {
  kind: StopReadinessKind;
  anchor: string;
  done: boolean;
};

export type StopReadinessInput = {
  cleaningDone: boolean;
  savedPhoto: boolean;
  selectedPhoto: boolean;
  photoSaving: boolean;
  smartReturnRequired: number;
  smartReturnOutstanding: number;
  smartXyRequired: number;
  smartXyOutstanding: number;
  compressorInstalled: boolean;
  compressorProofReady: boolean;
  submitting: boolean;
};

export function getStopCompletionReadiness(input: StopReadinessInput) {
  const steps: StopReadinessStep[] = [
    {kind: "cleaning", anchor: "cleaning-checklist", done: input.cleaningDone},
    {
      kind: "photo", anchor: "refill-proof",
      // A locally selected photo is uploaded by the existing completion handler.
      // It is not labelled "saved" until server upload confirms it.
      done: !input.photoSaving && (input.savedPhoto || input.selectedPhoto),
    },
  ];
  if (input.smartReturnRequired > 0 || input.smartReturnOutstanding > 0) {
    steps.push({
      kind: "smart-return", anchor: "smart-route-changes",
      done: input.smartReturnOutstanding === 0,
    });
  }
  if (input.smartXyRequired > 0 || input.smartXyOutstanding > 0) {
    steps.push({
      kind: "smart-xy", anchor: "smart-route-changes",
      done: input.smartXyOutstanding === 0,
    });
  }
  if (input.compressorInstalled) {
    steps.push({
      kind: "compressor", anchor: "compressor-safety",
      done: input.compressorProofReady,
    });
  }
  const missing = steps.filter(step => !step.done);
  const busy = input.submitting || input.photoSaving;
  return {
    steps,
    missing,
    completedCount: steps.length - missing.length,
    remainingCount: missing.length,
    busy,
    canComplete: missing.length === 0 && !busy,
    next: missing[0] ?? null,
  };
}
