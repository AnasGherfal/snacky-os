import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { hasPermission, isOwnerAdminRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { groupInvestorHistory, investorHistoryColumns, type InvestorHistoricalMonth } from '@/lib/investor-history';
import { InvestorHistoryTable } from '@/components/InvestorHistoryTable';

export async function InvestorHistoryLayout({ children, ownerOnly = false }: {
  children: ReactNode;
  ownerOnly?: boolean;
}) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active'
    || (ownerOnly ? !isOwnerAdminRole(profile) : !hasPermission(profile, 'investor.view'))) {
    redirect('/unauthorized');
  }
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const db = await getAuthenticatedSupabaseServerClient();
  const admin = isOwnerAdminRole(profile);
  let records: InvestorHistoricalMonth[] = [];
  const names = new Map<string, string>([[profile.id, profile.full_name]]);
  let failed = !db;
  if (db) {
    try {
      // Authenticated RLS plus explicit investor scoping; never a service-role read.
      // This history is attached to the login, not to an invented capital agreement.
      for (let from = 0; from < 10000; from += 500) {
        let query = db.from('investor_historical_months').select(investorHistoryColumns)
          .order('investor_user_id').order('month_start').order('id').range(from, from + 499);
        if (!admin) query = query.eq('investor_user_id', profile.id);
        const result = await query;
        if (result.error) throw result.error;
        const page = (result.data ?? []) as unknown as InvestorHistoricalMonth[];
        records.push(...page);
        if (page.length < 500) break;
        if (from === 9500) throw new Error('Historical source limit exceeded. No partial total is shown.');
      }
      if (admin && records.length) {
        const ids = [...new Set(records.map(row => row.investor_user_id))];
        for (let offset = 0; offset < ids.length; offset += 250) {
          const result = await db.from('profiles').select('id,full_name').in('id', ids.slice(offset, offset + 250));
          if (result.error) throw result.error;
          for (const person of result.data ?? []) names.set(String(person.id), String(person.full_name));
        }
      }
    } catch (error) {
      console.error('[investor-history] Could not verify historical records', error);
      failed = true;
      records = [];
    }
  }
  const groups = groupInvestorHistory(records);
  return (
    <>
      {!failed && records.length > 0 ? <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
        <a className="font-semibold text-sky-800 underline underline-offset-4" href="#historical-investor-records">
          {tr('View imported historical months', 'عرض الأشهر التاريخية المستوردة')} ({records.length})
        </a>
        <span className="ms-2 text-slate-600">{tr('Separate from new monthly calculations and payouts.', 'منفصلة عن الحسابات والدفعات الشهرية الجديدة.')}</span>
      </div> : null}
      {children}
      {failed ? <section id="historical-investor-records" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
        {tr('Historical investor records could not load. This does not mean the history is empty; refresh after the connection or database setup is restored.', 'تعذر تحميل السجل التاريخي للمستثمر. هذا لا يعني أن السجل فارغ؛ أعد التحميل بعد استعادة الاتصال أو إعداد قاعدة البيانات.')}
      </section> : records.length > 0 ? <section id="historical-investor-records" className="mt-8 scroll-mt-24 space-y-4" aria-labelledby="investor-history-heading">
        <div>
          <h2 id="investor-history-heading" className="text-xl font-semibold text-slate-950">{tr('Historical months · supplied figures', 'الأشهر التاريخية · الأرقام المقدّمة')}</h2>
          <p className="mt-1 text-sm text-slate-600">{tr('The original records remain visible here, even while the ongoing agreement is not set up. They are not included in the LYD totals above.', 'تبقى السجلات الأصلية ظاهرة هنا حتى لو لم تُجهّز الاتفاقية المستمرة بعد. لا تدخل هذه الأرقام في الإجماليات بالدينار أعلاه.')}</p>
        </div>
        {[...groups].map(([investorId, rows]) => <InvestorHistoryTable
          key={investorId} rows={rows} investorName={names.get(investorId) || tr('Investor', 'المستثمر')} ar={ar}
        />)}
      </section> : null}
    </>
  );
}
