import type { projectMandatoryWork } from '@/lib/self-dispatch-duties';

type Coverage = ReturnType<typeof projectMandatoryWork>;

/** Responsibility stays separate from the next-trip checkboxes. */
export default function DailyCoveragePanel({ coverage, selected, locale }: {
  coverage: Coverage; selected: string[]; locale: 'en' | 'ar';
}) {
  const ar = locale === 'ar';
  const t = (en: string, arabic: string) => ar ? arabic : en;
  const outsideTrip = coverage.rows.filter(row => !selected.includes(row.machineId));
  return <section aria-label={t('Required service coverage', 'متابعة التعبئة المطلوبة')}
    className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-emerald-950">{t('Must finish — not optional stops', 'تعبئة مطلوبة — ليست اختيارات')}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          {t('A smaller trip does not cancel the rest of the day’s required work.', 'اختيار جولة أصغر لا يلغي باقي التعبئة المطلوبة خلال اليوم.')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs font-semibold" aria-live="polite">
        <span className="rounded-full bg-emerald-50 px-3 py-2 text-emerald-950">{coverage.total} {t('required / assigned', 'مطلوبة أو مسندة')}</span>
        <span className={`rounded-full px-3 py-2 ${coverage.uncovered ? 'bg-red-50 text-red-900' : 'bg-slate-100 text-slate-700'}`}>
          {coverage.uncovered} {t('without confirmed coverage', 'بدون تغطية مؤكدة')}
        </span>
      </div>
    </div>

    {coverage.urgentUncovered > 0 ? <div role="status" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-950">
      <strong>{coverage.urgentUncovered} {t('urgent machines still need an operator.', 'ماكينات عاجلة ما زالت تحتاج مشغلاً.')}</strong>{' '}
      {t('Previewing a trip does not assign responsibility or mark these machines as handled.', 'معاينة الجولة لا تسند المسؤولية ولا تعني أن هذه الماكينات تم التعامل معها.')}
    </div> : null}

    <div className="space-y-2">{coverage.rows.map(row => <div key={row.machineId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
      <div>
        <div className="font-semibold text-slate-950">{row.name}</div>
        <p className={`mt-1 text-xs ${row.responsible ? 'text-emerald-800' : 'font-semibold text-red-800'}`}>
          {row.responsible
            ? `${t('Responsible through existing route', 'المسؤول حسب الجولة المسندة')}: ${row.responsible}`
            : t('No confirmed operator — needs coverage', 'لا يوجد مشغل مؤكد — تحتاج تغطية')}
        </p>
        {row.state === 'conflict' ? <p className="mt-1 text-xs font-semibold text-red-900">{t('Conflicting assignments — resolve before dispatch.', 'إسنادات متعارضة — يجب حلها قبل التحرك.')}</p> : null}
        {!row.openToday ? <p className="mt-1 text-xs text-amber-900">{t('Site closed today — access needs resolving, not silently skipping.', 'الموقع مغلق اليوم — يجب حل مشكلة الدخول، وليس تجاهل الماكينة.')}</p> : null}
      </div>
      <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${selected.includes(row.machineId) ? 'bg-emerald-100 text-emerald-950' : 'bg-slate-100 text-slate-800'}`}>
        {selected.includes(row.machineId) ? t('In this preview', 'في هذه المعاينة') : row.responsible ? t('Assigned separately', 'مسندة في جولة أخرى') : t('Still needs coverage', 'ما زالت تحتاج تغطية')}
      </span>
    </div>)}</div>

    {outsideTrip.length > 0 ? <p className="text-sm font-medium leading-6 text-slate-800">
      {t('Outside this preview, but still on the service board:', 'خارج هذه المعاينة، ولكنها ما زالت في قائمة المتابعة:')}{' '}
      {outsideTrip.map(row => row.name).join(' · ')}
    </p> : null}
    <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
      {t('Preview only: daily primary/backup coverage and visit deadlines are not configured or activated yet. Unassigned work is shown honestly; no operator or deadline is invented. Use the existing route assignment workflow until release.',
        'معاينة فقط: لم يتم تفعيل أو ضبط المسؤول الأساسي والبديل ومواعيد الزيارة بعد. نعرض العمل غير المسند كما هو دون افتراض مشغل أو موعد. استخدم إسناد الجولات الحالي إلى حين إطلاق الميزة.')}
    </p>
  </section>;
}
