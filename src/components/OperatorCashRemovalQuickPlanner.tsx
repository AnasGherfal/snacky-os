"use client";

import { useMemo, useState } from "react";

type MachineOption = { id: string; label: string };

/**
 * Operator-first cash removal: one machine = one sealed, traceable collection.
 * Reuses the existing validated cash_removal_plan server contract and custody RPC.
 * No amount is entered at pickup: a separate authorized counter records it later.
 * Use an opaque, serialized tamper-evident bag; photos show only its seal and ID.
 */
export function OperatorCashRemovalQuickPlanner({
  machines,
  selectedMachineId,
}: {
  machines: MachineOption[];
  selectedMachineId?: string;
}) {
  const eligible = machines.some((m) => m.id === selectedMachineId);
  const [machineId, setMachineId] = useState(eligible ? selectedMachineId! : "");
  const [bagId, setBagId] = useState("");
  const plan = useMemo(() => ({
    boxes: machineId && bagId.trim()
      ? [{
          box_key: "box-1",
          cash_bag_id: bagId.trim().toUpperCase(),
          machines: [{ machine_id: machineId, removed_amount_lyd: null }],
        }]
      : [],
  }), [machineId, bagId]);

  return (
    <div className="space-y-4" dir="rtl">
      <textarea hidden aria-hidden="true" tabIndex={-1} name="cash_removal_plan" readOnly value={JSON.stringify(plan)} />

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="font-bold text-emerald-950">سحب النقدية من ماكينة واحدة</p>
        <p className="mt-1 text-sm leading-6 text-emerald-900">
          اختار الماكينة، واستخدم كيساً أمنياً معتماً ومرقماً، وسجّل الرقم وصوّر الختم فقط. لا تصوّر أو تظهر الفلوس؛ العدّ يتم بعد التسليم.
        </p>
      </div>

      <label className="grid gap-2 text-sm font-semibold text-slate-800">
        ١. الماكينة
        <select className="field-input" value={machineId} required onChange={(event) => setMachineId(event.target.value)}>
          <option value="">اختار الماكينة</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>

      <label className="grid gap-2 text-sm font-semibold text-slate-800">
        ٢. رقم كيس النقدية / الختم
        <input
          className="field-input"
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={120}
          required
          value={bagId}
          onChange={(event) => setBagId(event.target.value.toUpperCase())}
          placeholder="مثال: SNK-000145"
          dir="ltr"
        />
      </label>

      <label className="grid gap-2 text-sm font-semibold text-slate-800">
        ٣. صورة رقم الكيس والختم بعد الإغلاق
        <input
          className="field-input"
          type="file"
          name="box_evidence_box-1"
          accept="image/png,image/jpeg,image/webp"
          capture="environment"
          required
        />
      </label>

      <p className="text-xs leading-6 text-slate-600">
        كل ماكينة في كيس أمني معتم ومستقل؛ لا تكتب المبلغ على الكيس. بعد الحفظ سلّم الكيس في المكان الآمن من صفحة النقدية، ثم يتم تسجيل الاستلام والعدّ من الشخص المصرّح له.
      </p>
    </div>
  );
}
