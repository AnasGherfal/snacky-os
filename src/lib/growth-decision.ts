export type GrowthDecisionInput = {
  cashAvailableLyd: number;
  machineCostLyd: number;
  minimumCashReserveLyd: number;
  restockReserveLyd: number;
  investorDueLyd: number;
  minimumMonthlyOperatingProfitLyd: number;
  averageMonthlyOperatingProfitLyd: number;
  averageMachineProfitAfterRentLyd: number;
  targetPaybackMonths: number;
  acceptedLocationCount: number;
  criticalRestockCount: number;
  openCriticalIssueCount: number;
  weakMachineCount: number;
  historyMonthCount: number;
  minimumHistoryMonths: number;
};

export type GrowthDecisionCode =
  | "buy_now"
  | "prepare_location"
  | "fund_stock_first"
  | "fix_existing_first"
  | "build_cash_reserve"
  | "improve_profit_first"
  | "collect_more_history"
  | "do_not_buy_payback";

export type GrowthDecision = {
  code: GrowthDecisionCode;
  title: string;
  titleAr: string;
  summary: string;
  summaryAr: string;
  confidence: "high" | "medium" | "low";
  score: number;
  projectedPaybackMonths: number | null;
  cashAfterCommitmentsLyd: number;
  cashAfterMachinePurchaseLyd: number;
  reserveGapLyd: number;
  reasons: string[];
  reasonsAr: string[];
  priorities: Array<{
    key: string;
    label: string;
    labelAr: string;
    amountLyd: number | null;
    status: "required" | "recommended" | "clear";
  }>;
};

function money(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function nonNegative(value: number) {
  return Math.max(0, money(value));
}

function payback(machineCost: number, monthlyProfit: number) {
  if (machineCost <= 0 || monthlyProfit <= 0) return null;
  return Math.round((machineCost / monthlyProfit) * 10) / 10;
}

function scoreInput(input: GrowthDecisionInput, projectedPaybackMonths: number | null, cashAfterMachinePurchaseLyd: number) {
  let score = 100;
  if (input.historyMonthCount < input.minimumHistoryMonths) score -= 25;
  if (input.acceptedLocationCount <= 0) score -= 25;
  if (input.criticalRestockCount > 0) score -= Math.min(20, 5 + input.criticalRestockCount * 2);
  if (input.openCriticalIssueCount > 0) score -= Math.min(20, 8 + input.openCriticalIssueCount * 4);
  if (input.weakMachineCount > 0) score -= Math.min(15, input.weakMachineCount * 4);
  if (input.averageMonthlyOperatingProfitLyd < input.minimumMonthlyOperatingProfitLyd) score -= 20;
  if (cashAfterMachinePurchaseLyd < input.minimumCashReserveLyd) score -= 30;
  if (projectedPaybackMonths === null) score -= 20;
  else if (projectedPaybackMonths > input.targetPaybackMonths) score -= 25;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildGrowthDecision(input: GrowthDecisionInput): GrowthDecision {
  const cashAfterCommitmentsLyd = money(
    input.cashAvailableLyd - nonNegative(input.investorDueLyd) - nonNegative(input.restockReserveLyd),
  );
  const cashAfterMachinePurchaseLyd = money(cashAfterCommitmentsLyd - nonNegative(input.machineCostLyd));
  const reserveGapLyd = nonNegative(input.minimumCashReserveLyd - cashAfterMachinePurchaseLyd);
  const projectedPaybackMonths = payback(input.machineCostLyd, input.averageMachineProfitAfterRentLyd);
  const score = scoreInput(input, projectedPaybackMonths, cashAfterMachinePurchaseLyd);

  const priorities: GrowthDecision["priorities"] = [
    {
      key: "investor_due",
      label: "Investor amount due",
      labelAr: "المبلغ المستحق للمستثمر",
      amountLyd: nonNegative(input.investorDueLyd),
      status: input.investorDueLyd > 0 ? "required" : "clear",
    },
    {
      key: "restock_reserve",
      label: "Protected restocking reserve",
      labelAr: "احتياطي شراء المنتجات",
      amountLyd: nonNegative(input.restockReserveLyd),
      status: input.criticalRestockCount > 0 ? "required" : "recommended",
    },
    {
      key: "cash_reserve",
      label: "Minimum cash reserve after purchase",
      labelAr: "الحد الأدنى للنقد بعد الشراء",
      amountLyd: nonNegative(input.minimumCashReserveLyd),
      status: reserveGapLyd > 0 ? "required" : "clear",
    },
    {
      key: "machine_purchase",
      label: "New machine purchase",
      labelAr: "شراء جهاز جديد",
      amountLyd: nonNegative(input.machineCostLyd),
      status: "recommended",
    },
  ];

  const commonReasons: string[] = [];
  const commonReasonsAr: string[] = [];
  commonReasons.push(`Cash after investor due and protected restocking reserve: ${cashAfterCommitmentsLyd.toLocaleString("en-US")} LYD.`);
  commonReasonsAr.push(`النقد بعد مستحق المستثمر واحتياطي المنتجات: ${cashAfterCommitmentsLyd.toLocaleString("en-US")} د.ل.`);
  if (projectedPaybackMonths !== null) {
    commonReasons.push(`Estimated payback from current machine performance: ${projectedPaybackMonths} months.`);
    commonReasonsAr.push(`مدة استرداد التكلفة حسب أداء الأجهزة الحالية: ${projectedPaybackMonths} شهر.`);
  }

  const result = (
    code: GrowthDecisionCode,
    title: string,
    titleAr: string,
    summary: string,
    summaryAr: string,
    reasons: string[],
    reasonsAr: string[],
    confidence: GrowthDecision["confidence"],
  ): GrowthDecision => ({
    code,
    title,
    titleAr,
    summary,
    summaryAr,
    confidence,
    score,
    projectedPaybackMonths,
    cashAfterCommitmentsLyd,
    cashAfterMachinePurchaseLyd,
    reserveGapLyd,
    reasons: [...reasons, ...commonReasons],
    reasonsAr: [...reasonsAr, ...commonReasonsAr],
    priorities,
  });

  if (input.historyMonthCount < input.minimumHistoryMonths) {
    return result(
      "collect_more_history",
      "Collect more reliable history",
      "اجمع بيانات أكثر قبل القرار",
      "Do not commit to another machine until enough complete monthly sales and expense history exists.",
      "لا تلتزم بشراء جهاز جديد قبل توفر عدد كافٍ من الأشهر المكتملة للمبيعات والمصاريف.",
      [`Only ${input.historyMonthCount} complete month(s) are available; the rule requires ${input.minimumHistoryMonths}.`],
      [`المتاح ${input.historyMonthCount} شهر مكتمل فقط، بينما القاعدة تتطلب ${input.minimumHistoryMonths}.`],
      "low",
    );
  }

  if (input.openCriticalIssueCount > 0) {
    return result(
      "fix_existing_first",
      "Fix existing machines first",
      "أصلح الأجهزة الحالية أولاً",
      "Protect current revenue before adding another machine.",
      "احمِ إيرادات الأجهزة الحالية قبل إضافة جهاز جديد.",
      [`${input.openCriticalIssueCount} critical machine issue(s) are still open.`],
      [`يوجد ${input.openCriticalIssueCount} عطل حرج مفتوح في الأجهزة.`],
      "high",
    );
  }

  if (input.criticalRestockCount > 0) {
    return result(
      "fund_stock_first",
      "Fund products before buying hardware",
      "موّل المنتجات قبل شراء جهاز",
      "A machine without enough stock will not create the expected return.",
      "الجهاز من دون مخزون كافٍ لن يحقق العائد المتوقع.",
      [`${input.criticalRestockCount} critical restocking item(s) need attention.`],
      [`يوجد ${input.criticalRestockCount} منتجاً بحالة شراء حرجة.`],
      "high",
    );
  }

  if (input.averageMonthlyOperatingProfitLyd < input.minimumMonthlyOperatingProfitLyd) {
    return result(
      "improve_profit_first",
      "Improve operating profit first",
      "ارفع الربح التشغيلي أولاً",
      "Current profit does not yet meet the minimum expansion rule.",
      "الربح الحالي لم يصل بعد إلى الحد الأدنى للتوسع.",
      [
        `Average monthly operating profit is ${money(input.averageMonthlyOperatingProfitLyd).toLocaleString("en-US")} LYD versus the ${money(input.minimumMonthlyOperatingProfitLyd).toLocaleString("en-US")} LYD rule.`,
        input.weakMachineCount > 0 ? `${input.weakMachineCount} machine(s) are weak or unprofitable after rent.` : "Existing machines should produce a stronger buffer before expansion.",
      ],
      [
        `متوسط الربح التشغيلي الشهري ${money(input.averageMonthlyOperatingProfitLyd).toLocaleString("en-US")} د.ل مقابل حد ${money(input.minimumMonthlyOperatingProfitLyd).toLocaleString("en-US")} د.ل.`,
        input.weakMachineCount > 0 ? `يوجد ${input.weakMachineCount} جهازاً ضعيفاً أو غير مربح بعد الإيجار.` : "يجب أن تحقق الأجهزة الحالية هامش أمان أكبر قبل التوسع.",
      ],
      "high",
    );
  }

  if (input.acceptedLocationCount <= 0) {
    return result(
      "prepare_location",
      "Secure a location before buying",
      "أمّن موقعاً قبل شراء الجهاز",
      "Do not leave a paid machine waiting without an accepted location.",
      "لا تشترِ جهازاً ليبقى من دون موقع مقبول وجاهز.",
      ["There is no accepted location lead ready for conversion."],
      ["لا يوجد موقع محتمل بحالة مقبول وجاهز للتحويل."],
      "high",
    );
  }

  if (cashAfterMachinePurchaseLyd < input.minimumCashReserveLyd) {
    return result(
      "build_cash_reserve",
      "Build cash reserve first",
      "ارفع الاحتياطي النقدي أولاً",
      "Buying now would leave Snacky below the protected cash floor.",
      "الشراء الآن سيترك سناكي تحت الحد الآمن للنقد.",
      [`An additional ${reserveGapLyd.toLocaleString("en-US")} LYD is needed to buy while preserving the minimum reserve.`],
      [`تحتاج إلى ${reserveGapLyd.toLocaleString("en-US")} د.ل إضافية للشراء مع الحفاظ على الاحتياطي الأدنى.`],
      "high",
    );
  }

  if (projectedPaybackMonths === null || projectedPaybackMonths > input.targetPaybackMonths) {
    return result(
      "do_not_buy_payback",
      "The payback is too slow",
      "مدة استرداد التكلفة طويلة",
      "Use the money to improve stronger locations, stock availability, or operating efficiency instead.",
      "استخدم المال لتحسين المواقع الأقوى أو توفر المنتجات أو كفاءة التشغيل بدلاً من ذلك.",
      [
        projectedPaybackMonths === null
          ? "Current machine profit is not positive enough to estimate a safe payback."
          : `Estimated payback is ${projectedPaybackMonths} months, above the ${input.targetPaybackMonths}-month target.`,
      ],
      [
        projectedPaybackMonths === null
          ? "ربح الأجهزة الحالي غير كافٍ لحساب استرداد آمن للتكلفة."
          : `مدة الاسترداد المتوقعة ${projectedPaybackMonths} شهر، أعلى من الهدف ${input.targetPaybackMonths} شهر.`,
      ],
      "high",
    );
  }

  return result(
    "buy_now",
    "Buy the next machine",
    "اشترِ الجهاز التالي",
    "The current cash, profit, location, and payback rules support expansion.",
    "النقد والربح والموقع ومدة الاسترداد الحالية تدعم التوسع.",
    [
      `${input.acceptedLocationCount} accepted location lead(s) are available.`,
      `Cash after buying the machine would remain ${cashAfterMachinePurchaseLyd.toLocaleString("en-US")} LYD.`,
    ],
    [
      `يوجد ${input.acceptedLocationCount} موقعاً مقبولاً متاحاً.`,
      `سيبقى بعد شراء الجهاز ${cashAfterMachinePurchaseLyd.toLocaleString("en-US")} د.ل نقداً.`,
    ],
    score >= 80 ? "high" : "medium",
  );
}
