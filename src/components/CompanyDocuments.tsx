import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from '@/lib/auth';
import { hasAnyRole, isOwnerAdminRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { PageHeader, ErrorState } from '@/components/ui';
import { companyHubEnabled, companyRoles, companyText, type CompanyItem, type CompanyWorkspaceData } from '@/lib/company-hub';
import { companyDocumentFile, companyDocumentMaster, companyDocumentReady, companyDocumentQuery, companyDocumentHref } from '@/lib/company-documents';

type Params = Record<string, string | string[] | undefined>;

export async function CompanyDocuments({ searchParams = {} }: { searchParams?: Params }) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || !hasAnyRole(profile, companyRoles)) redirect('/unauthorized');
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const profileManager = isOwnerAdminRole(profile);
  if (!profileManager && (searchParams.edit === '1' || searchParams.draft === '1')) redirect('/unauthorized');
  if (!companyHubEnabled) return <ErrorState title={tr('Company hub is not enabled', 'مساحة الشركة غير مفعّلة')} body={tr('Your normal workspaces remain available.', 'مساحات العمل المعتادة تبقى متاحة.')} />;
  const { q, offset } = companyDocumentQuery(searchParams);
  let data: CompanyWorkspaceData;
  try {
    const db = await getAuthenticatedSupabaseServerClient();
    if (!db) throw Error('No session');
    const result = await db.rpc('snacky_company_workspace_v1', { p_id: null, p_filters: { section: 'documents', q, offset: String(offset) } });
    if (result.error || !result.data || !Array.isArray(result.data.rows) || (!Number.isSafeInteger(result.data.total) || result.data.total < 0)) throw Error('Library unavailable');
    data = result.data as CompanyWorkspaceData;
  } catch {
    return <ErrorState title={tr('Company materials unavailable', 'مواد الشركة غير متاحة')} body={tr('Could not verify these materials or your access. This is not an empty library. Reload when the connection is restored; your operational work remains independent.', 'تعذر التحقق من المواد أو صلاحيات الوصول. هذا لا يعني أن المكتبة فارغة. أعد التحميل بعد استعادة الاتصال؛ يظل العمل التشغيلي مستقلاً.')} />;
  }
  const manager = profileManager && data.manager;
  const rows = data.rows.filter(item => !item.archived && (manager || item.current_version > 0));
  const ready = rows.filter(companyDocumentReady);
  const unfinished = rows.filter(item => !companyDocumentReady(item));
  const day = (date: string | null) => date ? date.slice(0, 10) : '—';

  function material(item: CompanyItem, complete: boolean) {
    const file = complete ? companyDocumentFile(item) : null;
    const master = complete ? companyDocumentMaster(item) : null;
    return <article className={`doc-material${complete ? '' : ' doc-material-draft'}`} key={item.id}>
      <div className="doc-material-top">
        <div className="doc-file-symbol" aria-hidden="true">{complete ? '↗' : '…'}</div>
        <div className="doc-material-main">
          <div className="doc-status-line">
            <span className={`doc-badge ${complete ? 'doc-badge-published' : 'doc-badge-draft'}`}>{complete ? `${tr('Published', 'منشور')} · v${item.current_version}` : tr('Not ready to use', 'غير جاهز للاستخدام')}</span>
            {complete ? <span className="doc-sharing">{item.data.external_shareable ? tr('Approved for external sharing', 'معتمد للمشاركة الخارجية') : tr('Internal use only', 'للاستخدام الداخلي فقط')}</span> : null}
          </div>
          <h3><Link href={`/company/items/${item.id}`}>{companyText(item.data, 'title', ar)}</Link></h3>
          <p className="doc-summary">{companyText(item.data, 'summary', ar)}</p>
          {!complete ? <p className="doc-draft-reason">{!companyDocumentFile(item) && !companyDocumentMaster(item) ? tr('Attach the actual approved file to this existing record, then review and publish.', 'أرفق الملف المعتمد الفعلي بهذا السجل الموجود، ثم راجعه وانشره.') : tr('A file is attached. The saved draft still needs review and publication.', 'الملف مرفق. ما زالت المسودة المحفوظة تحتاج إلى المراجعة والنشر.')}</p> : null}
          <dl className="doc-metadata">
            <div><dt>{tr('Owner', 'المسؤول')}</dt><dd>{item.owner_name || tr('Not assigned', 'غير محدد')}</dd></div>
            {complete ? <div><dt>{tr('Published', 'تاريخ النشر')}</dt><dd><bdi>{day(item.published_at)}</bdi></dd></div> : null}
            <div><dt>{tr('Review by', 'المراجعة بحلول')}</dt><dd><bdi>{item.data.review_date || '—'}</bdi></dd></div>
          </dl>
        </div>
      </div>
      <div className="doc-actions">
        <Link className="btn-secondary" href={`/company/items/${item.id}`}>{tr('View record & versions', 'عرض السجل والنسخ')}</Link>
        {file ? <a className="btn-primary" href={file}>{tr('Download published file', 'تنزيل الملف المنشور')}</a> : null}
        {master ? <a className="btn-secondary" href={master} target="_blank" rel="noopener noreferrer">{tr('Open editable master', 'فتح الأصل القابل للتعديل')}</a> : null}
        {manager && !complete ? <Link className="btn-primary" href={`/company/items/${item.id}?${companyDocumentFile(item) || companyDocumentMaster(item) ? 'draft=1' : 'edit=1'}`}>{companyDocumentFile(item) || companyDocumentMaster(item) ? tr('Review draft', 'مراجعة المسودة') : tr('Attach file', 'إرفاق الملف')}</Link> : null}
        {manager && complete && item.has_unpublished_changes ? <Link className="doc-text-link" href={`/company/items/${item.id}?draft=1`}>{tr('Review unpublished edits', 'مراجعة تعديلات غير منشورة')}</Link> : null}
      </div>
      {master ? <p className="doc-fine-print">{tr('A master link can change. Keep the exact issued copy on the relevant business record.', 'قد يتغير الملف الأصلي المرتبط. احتفظ بالنسخة الصادرة فعلياً في سجل العمل المعني.')}</p> : null}
    </article>;
  }

  return <div className="company-hub company-document-library" dir={ar ? 'rtl' : 'ltr'}>
    <PageHeader title={tr('Documents & Brand', 'الوثائق والهوية')} subtitle={tr('Current files. Clear approval. One trusted library.', 'الملفات الحالية، واعتماد واضح، ومكتبة واحدة موثوقة.')} action={manager ? <Link className="btn-primary" href="/company/new?section=documents">{tr('Add a material', 'إضافة مادة')}</Link> : undefined} />
    <form method="get" action="/company/documents" className="doc-search" role="search">
      <label htmlFor="company-doc-search">{tr('Find a file, guide or template', 'ابحث عن ملف أو دليل أو قالب')}</label>
      <div className="doc-search-controls"><input id="company-doc-search" name="q" type="search" maxLength={200} defaultValue={q} className="field-input" placeholder={tr('Search titles and descriptions…', 'ابحث في العناوين والأوصاف…')} /><button className="btn-primary" type="submit">{tr('Search', 'بحث')}</button>{q || offset ? <Link className="btn-secondary" href="/company/documents">{tr('Clear', 'مسح')}</Link> : null}</div>
    </form>
    <div className="doc-workspace">
      <div className="doc-results">
        <section aria-labelledby="doc-published-heading">
          <div className="doc-section-heading"><h2 id="doc-published-heading">{tr('Published materials', 'المواد المنشورة')}</h2><span>{ready.length} {tr('on this page', 'في هذه الصفحة')}</span></div>
          <p className="doc-section-description">{tr('Downloads use the library’s published attachment—not a separate website copy.', 'التنزيل من المرفق المنشور في المكتبة، وليس من نسخة منفصلة في الموقع.')}</p>
          {ready.length ? <div className="doc-material-list">{ready.map(item => material(item, true))}</div> : <div className="doc-empty"><h3>{q ? tr('No published materials match on this page', 'لا توجد مواد منشورة مطابقة في هذه الصفحة') : tr('No published files on this page yet', 'لا توجد ملفات منشورة في هذه الصفحة بعد')}</h3><p>{tr('Unfinished records and internal reference pages are not substitutes for an approved file.', 'السجلات غير المكتملة وصفحات المرجع الداخلي ليست بديلاً عن ملف معتمد.')}</p></div>}
        </section>
        {unfinished.length ? <section className="doc-pending" aria-labelledby="doc-pending-heading"><div className="doc-section-heading"><h2 id="doc-pending-heading">{manager ? tr('Finish existing materials', 'استكمال المواد الموجودة') : tr('File unavailable', 'الملف غير متاح')}</h2><span>{unfinished.length}</span></div><p className="doc-section-description">{manager ? tr('Continue these records instead of creating duplicates. Drafts are not distributed to staff.', 'أكمل هذه السجلات بدلاً من تكرارها. لا تُعرض المسودات للموظفين.') : tr('Contact the content owner. Do not substitute an older attachment.', 'تواصل مع مسؤول المحتوى. لا تستبدل الملف بمرفق قديم.')}</p><div className="doc-material-list">{unfinished.map(item => material(item, false))}</div></section> : null}
        <nav className="doc-pagination" aria-label={tr('Library pages', 'صفحات المكتبة')}>
          <span>{data.rows.length ? `${offset + 1}–${Math.min(offset + data.rows.length, data.total)} / ${data.total}` : `0 / ${data.total}`} {tr('library records', 'سجل في المكتبة')}</span>
          <div>{offset > 0 ? <Link className="btn-secondary" href={companyDocumentHref(q, Math.max(0, offset - 20))}>{tr('Previous', 'السابق')}</Link> : null}{offset + 20 < data.total ? <Link className="btn-secondary" href={companyDocumentHref(q, offset + 20)}>{tr('Next', 'التالي')}</Link> : null}</div>
        </nav>
      </div>
      <aside className="doc-sidebar" aria-label={tr('Library guidance', 'إرشادات المكتبة')}>
        <section className="doc-help"><p className="doc-eyebrow">{tr('Before sharing', 'قبل المشاركة')}</p><h2>{tr('Use the approved version.', 'استخدم النسخة المعتمدة.')}</h2><p>{tr('Check the version and external-sharing label. A guide page or a draft title containing “approved” does not authorize sharing.', 'راجع رقم النسخة ووسم المشاركة الخارجية. صفحة دليل أو كلمة «معتمد» داخل عنوان مسودة لا تمنح إذناً بالمشاركة.')}</p><Link className="doc-text-link" href="/company/guides">{tr('Working procedures', 'إجراءات العمل')}</Link></section>
        <details className="doc-reference"><summary>{tr('Internal reference pages', 'صفحات مرجع داخلي')}</summary><p>{tr('Background reading only—not the approved company profile or an issued brand manual.', 'للاطلاع الداخلي فقط؛ ليست الملف التعريفي المعتمد أو دليلاً رسمياً صادراً للهوية.')}</p><Link href="/company/profile">{tr('Service overview', 'نبذة عن الخدمة')}</Link><Link href="/company/brand-guide">{tr('Brand usage notes', 'ملاحظات استخدام الهوية')}</Link></details>
        {manager ? <details className="doc-reference"><summary>{tr('Create a missing material', 'إنشاء مادة غير موجودة')}</summary><p>{tr('Search first. Use a starter only when no existing record covers the material.', 'ابحث أولاً. استخدم قالباً أولياً فقط عندما لا يوجد سجل للمادة.')}</p>{[['logo-pack', 'Logo asset', 'ملف شعار'], ['company-profile', 'Company profile', 'ملف تعريفي'], ['brochure', 'Brochure', 'بروشور'], ['machine-catalog', 'Machine catalog', 'كتالوج الماكينات'], ['proposal-template', 'Proposal master', 'قالب عرض'], ['agreement-template', 'Blank agreement', 'اتفاقية فارغة'], ['receipt-delivery-templates', 'Receipt / delivery form', 'إيصال / نموذج تسليم']].map(([key, en, arabic]) => <Link key={key} href={`/company/new?template=${key}`}>{tr(en, arabic)}</Link>)}</details> : null}
      </aside>
    </div>
  </div>;
}
