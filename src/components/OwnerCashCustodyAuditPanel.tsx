import Link from "next/link";
import type {OwnerCashCustodyAudit, CashCustodyStage} from "@/lib/owner-cash-custody-audit";

const stageLabels:Record<CashCustodyStage,{en:string;ar:string}>={
  awaiting_handoff:{en:"Storage receipt still needed",ar:"بانتظار استلام المخزن"},
  awaiting_count:{en:"Physical count still needed",ar:"بانتظار العدّ الفعلي"},
  variance_review:{en:"Variance/source review",ar:"مراجعة فرق النقد أو المصدر"},
  awaiting_source:{en:"Count recorded · XY comparison pending",ar:"العدّ مسجل · بانتظار مطابقة XY"},
  other_review:{en:"Evidence or historical record review",ar:"مراجعة مستندات أو سجلات قديمة"},
};

export function OwnerCashCustodyAuditPanel({
  audit,locale,
}:{
  audit:OwnerCashCustodyAudit|null;
  locale:"ar"|"en";
}) {
  const ar=locale==="ar";
  const tr=(en:string,arabic:string)=>ar?arabic:en;
  const metrics=[
    [tr("Awaiting storage receipt", "بانتظار استلام المخزن"), audit?.waitingForStorageHandoff??null],
    [tr("Received but not counted", "استُلم ولم يُعدّ بعد"), audit?.waitingForPhysicalCount??null],
    [tr("Counted · XY pending", "معدود · بانتظار XY"), audit?.countedPendingSource??null],
    [tr("Variance/source review", "مراجعة فروقات أو مصادر"), audit?.variancePendingReview??null],
    [tr("Collector name not recorded", "اسم المحصّل غير مسجل"), audit?.collectorIdentityNotRecorded??null],
    [tr("Count witness not recorded", "شاهد العدّ غير مسجل"), audit?.countWitnessNotRecorded??null],
  ] as const;
  return (
    <section aria-labelledby="owner-cash-chain-title"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-5 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-emerald-800">{tr("SNACKY · CASH CHAIN", "سناكي · سلسلة عهدة النقد")}</p>
          <h2 id="owner-cash-chain-title" className="mt-1 text-lg font-bold text-slate-950">
            {tr("Collector → receiver → counter → witness", "المحصّل ← المستلم ← من قام بالعدّ ← الشاهد")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            {tr("Audit sealed cash bags, physical handoffs and missing record evidence. This panel does not move, count or reconcile any cash.",
              "راجع أكياس النقد المختومة والتسليم الفعلي والبيانات غير الموثّقة. هذه اللوحة لا تنقل النقد ولا تعدّه ولا تجري تسوية مالية.")}
          </p>
        </div>
        <Link href="/cash-collections"
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-emerald-900 hover:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
          {tr("All cash records", "جميع سجلات النقد")}
        </Link>
      </div>
      {audit===null ? (
        <p role="alert" className="mx-4 my-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 sm:mx-5">
          {tr("Cash chain could not be fully verified. Do not interpret missing rows or evidence as zero. Review the original cash records.",
            "تعذر التحقق الكامل من سلسلة عهدة النقد. لا تعتبر السجلات أو الإثباتات غير المتاحة صفراً. راجع سجلات النقد الأصلية.")}
        </p>
      ) : (
        <>
          <div className="grid gap-2 p-3 sm:grid-cols-2 sm:gap-3 sm:p-4 xl:grid-cols-3">
            {metrics.map(([title,value])=>(
              <div key={title} className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                <p className="text-xs font-semibold leading-5 text-slate-600">{title}</p>
                <strong className="mt-2 block text-2xl font-bold tabular-nums text-slate-950">
                  {value===null?tr("Unverified", "غير مؤكد"):value}
                </strong>
              </div>
            ))}
          </div>
          <p className="px-4 pb-3 text-xs leading-5 text-slate-600 sm:px-5">
            {tr(
              "These categories may overlap. Missing historical collector/witness details are documentation gaps, not proof of theft, lost funds, or a policy breach. Same-person receipt is recorded separately for review and may be authorized.",
              "قد تتداخل الفئات. نقص بيانات المحصّل أو شاهد العدّ في السجلات القديمة هو نقص توثيق، ولا يثبت سرقة أو ضياع مبلغ أو مخالفة. ويُسجل استلام نفس الشخص منفصلاً للمراجعة وقد يكون مصرحاً به.",
            )}
          </p>
          <div className="border-t border-slate-200 px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-bold text-slate-950">{tr("Cash bags needing follow-up", "أكياس النقد التي تحتاج متابعة")}</h3>
              <Link href="/cash-collections/action-queue" className="text-sm font-semibold text-emerald-800 underline-offset-2 hover:underline">
                {tr("Current action queue", "قائمة المهام الحالية")}
              </Link>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              {tr("Historical records are included for evidence review. Bag stage reflects recorded actions, not verified physical custody today.",
                "تظهر السجلات السابقة لمراجعة الإثباتات. مرحلة الكيس تعكس ما سُجّل ولا تؤكد مكان النقد الفعلي اليوم.")}
            </p>
            {audit.bagQueue.length===0 ? (
              <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                {tr("No outstanding cash-chain actions were identified in the verified records. Continue routine checks.",
                  "لم تظهر مهام معلقة في سلسلة عهدة النقد في السجلات المتحقق منها. واصل المراجعة الدورية.")}
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {audit.bagQueue.map(bag=>(
                  <article key={bag.id} className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="break-words text-sm font-bold text-slate-950">
                          {tr("Cash bag", "كيس النقد")}{" "}
                          <span className="tabular-nums">{bag.label}</span>
                        </h4>
                        <p className="mt-1 text-xs font-semibold text-amber-900">
                          {ar?stageLabels[bag.stage].ar:stageLabels[bag.stage].en}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {tr("Removed", "أُزيل")}:{" "}
                          {bag.collectedAt
                            ? new Intl.DateTimeFormat(ar?"ar-LY":"en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Africa/Tripoli"}).format(new Date(bag.collectedAt))
                            : tr("Date not recorded", "التاريخ غير مسجل")}
                        </p>
                      </div>
                      <Link href={"/cash-collections/"+bag.id}
                        className="inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
                        {tr("Review bag and evidence", "راجع الكيس والإثبات")}
                      </Link>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      {([
                        [tr("Collector", "المحصّل"),bag.collectedBy],
                        [tr("Storage receiver", "مستلم المخزن"),bag.receivedBy],
                        [tr("Counter", "من قام بالعدّ"),bag.countedBy],
                        [tr("Count witness", "شاهد العدّ"),bag.witnessedBy],
                      ] as const).map(([label,name])=>
                        <div key={label} className="min-w-0 rounded-lg bg-slate-50 p-2">
                          <p className="font-semibold text-slate-600">{label}</p>
                          <p className="mt-1 break-words text-slate-900">{name==="Not recorded"?tr("Not recorded", "غير مسجل"):name}</p>
                        </div>)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
                        {tr("Removal photo", "صورة الإزالة")}:{" "}
                        {bag.removalEvidenceRecorded?tr("Referenced", "موثقة"):tr("Not found in linked records", "غير موجودة في السجلات المرتبطة")}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
                        {tr("Storage handoff photo", "صورة تسليم المخزن")}:{" "}
                        {bag.storageEvidenceRecorded?tr("Referenced", "موثقة"):tr("Not found in event history", "غير موجودة في سجل الأحداث")}
                      </span>
                      {bag.samePersonHandoff? (
                        <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-900">
                          {tr("Same-person handoff recorded · review authorization", "استلام نفس الشخص مسجل · راجع الصلاحية")}
                        </span>
                      ):null}
                    </div>
                    {bag.flags.length>0? (
                      <p className="mt-2 text-xs leading-5 text-amber-900">
                        {tr("Audit coverage gaps / notes", "ملاحظات ونواقص التوثيق")}:{" "}
                        {bag.flags.map(flag=>({
                          collector_not_recorded:tr("Collector not recorded", "المحصّل غير مسجل"),
                          receiver_not_recorded:tr("Receiver not recorded", "المستلم غير مسجل"),
                          storage_evidence_not_recorded:tr("Storage photo reference not recorded", "مرجع صورة التسليم غير مسجل"),
                          removal_evidence_not_recorded:tr("Removal photo reference not recorded", "مرجع صورة الإزالة غير مسجل"),
                          counter_not_recorded:tr("Counter not recorded", "من قام بالعدّ غير مسجل"),
                          count_witness_not_recorded:tr("Witness not recorded", "شاهد العدّ غير مسجل"),
                          same_person_handoff_review:tr("Same-person receipt", "استلام نفس الشخص"),
                          seal_condition_review:tr("Seal condition requires review", "حالة الختم تحتاج مراجعة"),
                        }[flag]||flag)).join(" · ")}
                      </p>
                    ):null}
                  </article>
                ))}
              </div>
            )}
            {audit.bagQueue.length>0? (
              <p className="mt-3 text-xs leading-5 text-slate-600">
                {tr("Showing a short priority queue. Use All cash records to review the full historical chain.",
                  "تُعرض أهم الحالات فقط. استخدم جميع سجلات النقد لمراجعة السلسلة التاريخية الكاملة.")}
              </p>
            ):null}
          </div>
        </>
      )}
    </section>
  );
}
