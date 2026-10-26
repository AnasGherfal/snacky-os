/**
 * Read-only explanation of the expectation status recorded for each cash-box
 * machine link. This is not a new source of sales or a cash reconciliation.
 * "pending" means uncalculated; it does NOT prove missing VMS transactions.
 */
type MachineExpectationInput = {
  expectation_status?: string | null;
  interval_start_at?: string | null;
  removal_type?: string | null;
};

export type CashExpectationDiagnosis = {
  kind: "pending" | "missing_start" | "no_exact_vms_data"
    | "payment_split_incomplete" | "partial_removal"
    | "ready_cash_only_assumption" | "ready_exact"
    | "manual_override" | "review_unknown";
  heading: string;
  nextStep: string;
  needsAttention: boolean;
};

export function diagnoseCashMachineExpectation(
  input: MachineExpectationInput,
  locale: "ar" | "en" = "en",
): CashExpectationDiagnosis {
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const status = String(input.expectation_status ?? "pending").trim().toLowerCase() || "pending";

  if (status === "pending") return {
    kind: "pending",
    heading: tr("Comparison not calculated", "مقارنة النقد لم تُحسب بعد"),
    nextStep: tr(
      "Calculate the VMS expectation after counting the bag. A blank interval here does not yet prove the previous removal is missing.",
      "احسب النقد المتوقع من VMS بعد عد الكيس. غياب بداية الفترة هنا لا يثبت وحده عدم وجود سحب سابق.",
    ),
    needsAttention: true,
  };
  if (status === "missing_start") return {
    kind: "missing_start",
    heading: tr("Previous full removal not established", "لم تتحدد نقطة بداية السحب الكامل السابق"),
    nextStep: tr(
      "Review the last documented full cash removal. Do not invent a start date. If the interval cannot be established automatically, reconcile only against a documented combined XY cash total.",
      "راجع آخر سحب كامل موثق للنقد. لا تفترض تاريخ البداية. وإذا تعذر حساب الفترة آلياً، استخدم إجمالي نقد XY موثقاً للكيس بالكامل.",
    ),
    needsAttention: true,
  };
  if (status === "no_exact_vms_data") return {
    kind: "no_exact_vms_data",
    heading: tr("No matching raw VMS sales for this interval", "لا توجد مبيعات VMS خام مطابقة لهذه الفترة"),
    nextStep: tr(
      "Check raw transaction import dates, successful-sale status and machine mapping. Import verified raw data if available, or document one combined XY cash total for the whole bag.",
      "راجع تواريخ استيراد معاملات VMS الخام وحالة البيع وربط الجهاز. استورد البيانات المؤكدة أو وثّق إجمالي نقد XY للكيس بالكامل.",
    ),
    needsAttention: true,
  };
  if (status === "payment_split_incomplete") return {
    kind: "payment_split_incomplete",
    heading: tr("Cash/card payment split incomplete", "تصنيف معاملات النقد والبطاقات غير مكتمل"),
    nextStep: tr(
      "Verify payment methods in the source report; do not count card transactions as cash. Use a documented cash-only batch total if the source cannot be repaired.",
      "تحقق من طريقة الدفع في التقرير الأصلي. لا تحتسب معاملات البطاقات نقداً. استخدم إجمالي النقد الموثق إذا تعذر إصلاح البيانات.",
    ),
    needsAttention: true,
  };
  if (status === "partial_removal" || input.removal_type === "partial") return {
    kind: "partial_removal",
    heading: tr("Partial removal requires separate evidence", "السحب الجزئي يحتاج أدلة منفصلة"),
    nextStep: tr(
      "An exact full-interval cash comparison is not available for this partial removal. Verify the actual cash interval and document the one combined bag expectation.",
      "لا يمكن الاعتماد على مقارنة فترة السحب الكامل في حالة السحب الجزئي. تحقق من فترة النقد ووثّق الإجمالي المتوقع للكيس.",
    ),
    needsAttention: true,
  };
  if (status === "ready_cash_only_assumption") return {
    kind: "ready_cash_only_assumption",
    heading: tr("Cash-only assumption requires review", "افتراض الدفع النقدي يحتاج مراجعة"),
    nextStep: tr(
      "The VMS rows have unclassified payment methods. Verify they were all cash before treating the amount as a confirmed cash comparison.",
      "طريقة الدفع غير مصنفة في معاملات VMS. يجب التأكد من أنها نقدية قبل اعتماد المبلغ كمقارنة نقدية مؤكدة.",
    ),
    needsAttention: true,
  };
  if (status === "ready_exact") return {
    kind: "ready_exact",
    heading: tr("Exact cash transactions calculated", "تم حساب معاملات النقد بدقة"),
    nextStep: tr(
      "Verify the covered dates and machine against the original report before accepting a cash difference.",
      "تحقق من الفترة والجهاز والتقرير الأصلي قبل اعتماد أي فرق نقدي.",
    ),
    needsAttention: false,
  };
  if (status === "manual_override") return {
    kind: "manual_override",
    heading: tr("Documented combined manual expectation", "إجمالي نقد يدوي موثق للكيس"),
    nextStep: tr(
      "The manual total belongs to the whole cash bag, not an invented machine-by-machine allocation. Check the source notes.",
      "الإجمالي اليدوي يخص الكيس بالكامل وليس توزيعاً افتراضياً على الأجهزة. راجع ملاحظات المصدر.",
    ),
    needsAttention: false,
  };
  return {
    kind: "review_unknown",
    heading: tr("Unknown comparison status", "حالة مقارنة غير معروفة"),
    nextStep: tr(
      "Review the recorded status and original machine evidence before drawing financial conclusions.",
      "راجع الحالة المسجلة وأدلة الجهاز الأصلية قبل اتخاذ قرار مالي.",
    ),
    needsAttention: true,
  };
}
