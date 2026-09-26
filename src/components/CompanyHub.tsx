import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { redirect, notFound } from 'next/navigation';
import {
  getCurrentProfile,
  getAuthenticatedSupabaseServerClient,
} from '@/lib/auth';
import {
  hasAnyRole,
  isOwnerAdminRole,
  canAccessPath,
  getDefaultPathForRole,
} from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { PageHeader, ErrorState } from '@/components/ui';
import {
  CompanyAction,
  CompanyEditor,
  CompanyPrint,
} from '@/components/CompanyEditor';
import {
  companyHubEnabled,
  companyRoles,
  companyLabels,
  companySections,
  companyRoleLabels,
  companyDocumentCategories,
  companyDocumentCategory,
  companyDocumentCategoryLabels,
  companyUuid,
  companyText,
  emptyCompanyContent,
  type CompanySection,
  type CompanyWorkspaceData,
  type CompanyContent,
  type CompanyDocumentCategory,
} from '@/lib/company-hub';
import { companyTemplates, companyTemplate } from '@/lib/company-templates';
const documentCategoryDescriptions: Record<
  CompanyDocumentCategory,
  [string, string]
> = {
  brand: [
    'Logos, colors, typography, QR codes and approved visual assets.',
    'الشعارات والألوان والخطوط ورموز QR ومواد الهوية المعتمدة.',
  ],
  company: [
    'Company profile, presentations and reusable corporate references.',
    'الملف التعريفي والعروض والمراجع المؤسسية القابلة لإعادة الاستخدام.',
  ],
  sales: [
    'Reusable proposal masters and approved sales material.',
    'قوالب العروض والمواد التجارية المعتمدة القابلة لإعادة الاستخدام.',
  ],
  templates: [
    'Blank agreements, receipts and approved reusable forms.',
    'الاتفاقيات والإيصالات والنماذج الفارغة المعتمدة.',
  ],
  machines: [
    'Machine media, manuals and approved technical references.',
    'صور الماكينات والأدلة والمراجع الفنية المعتمدة.',
  ],
  marketing: [
    'Brochures, print assets and reusable marketing material.',
    'البروشورات ومواد الطباعة والتسويق القابلة لإعادة الاستخدام.',
  ],
  other: ['Other approved reusable material.', 'مواد أخرى معتمدة وقابلة لإعادة الاستخدام.'],
};

type Params = Record<string, string | string[] | undefined>;
const value = (params: Params, key: string) =>
  typeof params[key] === 'string' ? String(params[key]) : '';
export async function CompanyHub({
  parts = [],
  searchParams = {},
}: {
  parts?: string[];
  searchParams?: Params;
}) {
  const profile = await getCurrentProfile();
  if (
    !profile ||
    profile.active_status !== 'active' ||
    !hasAnyRole(profile, companyRoles)
  )
    redirect('/unauthorized');
  const { locale } = await getServerI18n(),
    ar = locale === 'ar',
    tr = (en: string, arabic: string) => (ar ? arabic : en),
    manager = isOwnerAdminRole(profile);
  if (!companyHubEnabled)
    return (
      <ErrorState
        title={tr('Company hub is not enabled', 'مساحة الشركة غير مفعّلة')}
        body={tr(
          'Your existing workspaces are unchanged. Management can enable this module after its database update and access checks.',
          'مساحات العمل الحالية لم تتغير. يمكن للإدارة تفعيل هذا القسم بعد تحديث قاعدة البيانات وفحص الصلاحيات.',
        )}
      />
    );
  const mode = parts[0] ?? 'start',
    isNew = mode === 'new',
    isRecord = mode === 'items';
  if (
    (!isNew &&
      !isRecord &&
      !companySections.includes(mode as CompanySection)) ||
    (isRecord && (!companyUuid.test(parts[1] ?? '') || parts.length !== 2)) ||
    (!isRecord && parts.length > 1)
  )
    notFound();
  if (
    (isNew ||
      mode === 'manage' ||
      value(searchParams, 'edit') === '1' ||
      value(searchParams, 'draft') === '1') &&
    !manager
  )
    redirect('/unauthorized');
  const section: CompanySection = isNew
    ? 'manage'
    : isRecord
      ? 'start'
      : (mode as CompanySection);
  let newId = value(searchParams, 'draft_id');
  if (isNew && !companyUuid.test(newId)) {
    newId = randomUUID();
    const q = new URLSearchParams({ draft_id: newId });
    for (const key of ['template', 'section', 'category']) {
      const v = value(searchParams, key);
      if (v) q.set(key, v);
    }
    redirect(`/company/new?${q}`);
  }
  const filters: Record<string, string> = { section };
  for (const key of ['q', 'offset', 'state', 'version', 'work_path']) {
    const v = value(searchParams, key);
    if (v) filters[key] = v;
  }
  let data: CompanyWorkspaceData;
  try {
    const db = await getAuthenticatedSupabaseServerClient();
    if (!db) throw Error('No session');
    const result = await db.rpc('snacky_company_workspace_v1', {
      p_id: isRecord ? parts[1] : null,
      p_filters: filters,
    });
    if (result.error || !result.data) throw result.error ?? Error('No data');
    data = result.data as CompanyWorkspaceData;
  } catch (error) {
    console.error('[company-hub] Read unavailable', {
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'unknown',
    });
    return (
      <ErrorState
        title={tr('Company materials unavailable', 'مواد الشركة غير متاحة')}
        body={tr(
          'Could not verify these materials or your access. This is not an empty library. Reload after the database update or connection is restored. Routes, inventory, cash and customer work remain independent.',
          'تعذر التحقق من المواد أو صلاحيات الوصول. هذا لا يعني أن المكتبة فارغة. أعد التحميل بعد تحديث قاعدة البيانات أو استعادة الاتصال. عمل المسارات والمخزون والنقد والعملاء مستقل عن هذا القسم.',
        )}
      />
    );
  }
  const originalRecord = data.record,
    edit = value(searchParams, 'edit') === '1';
  const draftPreview = Boolean(
    originalRecord &&
      manager &&
      !edit &&
      (value(searchParams, 'draft') === '1' ||
        originalRecord.current_version === 0),
  );
  const record =
    originalRecord && draftPreview && data.draft
      ? {
          ...originalRecord,
          data: data.draft,
          owner_name:
            data.directory.find((person) => person.id === data.draft?.owner_id)
              ?.name ?? null,
        }
      : originalRecord;
  const latestVersion = Math.max(
    originalRecord?.current_version ?? 0,
    ...data.history.map((item) => item.version),
  );
  const historical = Boolean(
    record &&
      !draftPreview &&
      record.current_version > 0 &&
      record.current_version < latestVersion,
  );
  const title = record
    ? companyText(record.data, 'title', ar)
    : isNew
      ? tr('Add company material', 'إضافة محتوى للشركة')
      : companyLabels[section][ar ? 1 : 0];
  const requestedSection = value(searchParams, 'section');
  const initial: CompanyContent = isNew
    ? (companyTemplate(value(searchParams, 'template')) ??
      emptyCompanyContent(
        ['start', 'guides', 'documents', 'people'].includes(requestedSection)
          ? (requestedSection as CompanyContent['section'])
          : 'guides',
      ))
    : (data.draft ?? record?.data ?? emptyCompanyContent());
  const requestedCategory = value(searchParams, 'category');
  if (
    isNew &&
    initial.section === 'documents' &&
    companyDocumentCategories.includes(
      requestedCategory as CompanyDocumentCategory,
    )
  )
    initial.document_category = requestedCategory as CompanyDocumentCategory;
  if (isNew && !initial.owner_id)
    initial.owner_id = profile.team_member_id ?? '';
  const pageHref = (offset: number) => {
    const p = new URLSearchParams(filters);
    p.delete('section');
    p.set('offset', String(offset));
    return `/company/${section}?${p}`;
  };
  return (
    <div className="company-hub min-w-0 space-y-5" dir={ar ? 'rtl' : 'ltr'}>
      {record ? (
        <nav
          aria-label={tr('Breadcrumb', 'مسار الصفحة')}
          className="flex flex-wrap items-center gap-2 text-sm text-slate-500 print:hidden"
        >
          <Link href="/company" className="hover:underline">
            {tr('Company', 'الشركة')}
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            className="hover:underline"
            href={`/company/${record.data.section}`}
          >
            {companyLabels[record.data.section][ar ? 1 : 0]}
          </Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="break-words text-slate-900">
            {title}
          </span>
        </nav>
      ) : null}
      <PageHeader
        title={title}
        subtitle={tr(
          'Find your responsibilities, current instructions and approved materials.',
          'مسؤولياتك وتعليمات العمل الحالية والمواد المعتمدة في مكان واحد.',
        )}
        action={
          isRecord || isNew ? (
            <Link className="btn-secondary" href="/company">
              {tr('Company home', 'الرئيسية')}
            </Link>
          ) : manager ? (
            <Link
              className="btn-primary"
              href={`/company/new?section=${section === 'documents' ? 'documents' : 'guides'}`}
            >
              + {tr('Add material', 'إضافة محتوى')}
            </Link>
          ) : null
        }
      />
      {section === 'documents' && !record && !isNew ? (
        <>
          <section className="surface-card space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  {tr('Snacky library', 'مكتبة سناكي')}
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  {tr('Approved reusable company materials', 'مواد الشركة المعتمدة والقابلة لإعادة الاستخدام')}
                </h2>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                  {tr(
                    'Use this library for current masters and approved assets. Actual signed agreements, sent proposals and payment evidence stay on their original business records.',
                    'استخدم هذه المكتبة للأصول الحالية والمواد المعتمدة. تبقى الاتفاقيات الموقعة والعروض المرسلة وإثباتات الدفع في سجلات العمل الأصلية الخاصة بها.',
                  )}
                </p>
              </div>
              <Link className="btn-secondary shrink-0" href="/company/profile">
                {tr('Snacky Company Profile', 'الملف التعريفي بسناكي')}
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {companyDocumentCategories
                .filter((category) => category !== 'other')
                .map((category) => (
                  <article
                    key={category}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <h3 className="font-semibold">
                      {companyDocumentCategoryLabels[category][ar ? 1 : 0]}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {documentCategoryDescriptions[category][ar ? 1 : 0]}
                    </p>
                    {manager ? (
                      <Link
                        className="mt-3 inline-block text-sm font-semibold underline"
                        href={`/company/new?section=documents&category=${category}`}
                      >
                        {tr('Add material here', 'إضافة مادة هنا')}
                      </Link>
                    ) : null}
                  </article>
                ))}
            </div>
            <div className="flex flex-wrap gap-3 border-t border-slate-200 pt-4 text-sm">
              <Link className="font-semibold underline" href="/company/guides">
                {tr('Operational SOPs & guides', 'إجراءات وأدلة التشغيل')}
              </Link>
              <Link className="font-semibold underline" href="/company/people">
                {tr('Roles & responsibilities', 'الأدوار والمسؤوليات')}
              </Link>
            </div>
          </section>
        </>
      ) : null}
      {section === 'start' && !record && !isNew ? (
        <>
          <section className="surface-card space-y-3">
            <h2 className="text-lg font-semibold">
              {tr('Start with your work', 'ابدأ بعملك')}
            </h2>
            <p className="text-sm text-slate-600">
              {tr(
                'Open your daily work, review the instructions for your role, and use the approved company materials.',
                'افتح عملك اليومي، وراجع تعليمات دورك، واستخدم مواد الشركة المعتمدة.',
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                className="btn-primary"
                href={getDefaultPathForRole(profile)}
              >
                {tr('Open my workspace', 'فتح مساحة عملي')}
              </Link>
              {getDefaultPathForRole(profile) !== '/my-work' &&
              canAccessPath(profile, '/my-work') ? (
                <Link className="btn-secondary" href="/my-work">
                  {tr('My assigned work', 'عملي المسند إليّ')}
                </Link>
              ) : null}
              {manager ? (
                <Link className="btn-secondary" href="/my-work/team">
                  {tr('Team decisions & follow-ups', 'قرارات الفريق ومتابعاته')}
                </Link>
              ) : null}
              <Link className="btn-secondary" href="/company/updates">
                {tr('Required reading', 'القراءة المطلوبة')} ·{' '}
                {data.required_count}
              </Link>
            </div>
          </section>
          {manager ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
              <h2 className="font-semibold">
                {tr('Set up the company library', 'تجهيز مكتبة الشركة')}
              </h2>
              <p className="mt-2">
                {tr(
                  'Review the starter drafts, assign content owners, then publish only approved wording. Upload the current logo and approved presentation as real files. Employee contracts and salary details stay in restricted staff records.',
                  'راجع المسودات الأولية وحدّد مسؤولي المحتوى ثم انشر النصوص المعتمدة فقط. ارفع الشعار الحالي والعرض المعتمد كملفات حقيقية. تبقى عقود الموظفين والمرتبات في سجلات الموظفين المقيدة.',
                )}
              </p>
              <Link
                className="mt-3 inline-block font-semibold underline"
                href="/company/manage"
              >
                {tr(
                  'Manage content and starter templates',
                  'إدارة المحتوى والقوالب الأولية',
                )}
              </Link>
            </section>
          ) : null}
        </>
      ) : null}
      {isNew || (record && edit) ? (
        <section className="surface-card">
          <CompanyEditor
            key={`${isNew ? newId : record!.id}:${record?.revision ?? 0}`}
            initial={initial}
            itemId={isNew ? newId : record!.id}
            revision={record?.revision ?? 0}
            userId={profile.id}
            directory={data.directory}
            ar={ar}
          />
        </section>
      ) : record ? (
        <>
          <style>{`.company-print-heading { display: none; } @media print {
html, body { background: white !important; height: auto !important; overflow: visible !important; }
.app-shell, .app-shell > div, .app-shell main, .app-shell main > div, .company-hub { display: block !important; height: auto !important; max-height: none !important; overflow: visible !important; }
.app-shell > aside, .app-shell > div > header, .app-shell main nav, .company-hub > :not(.company-print-article):not(style), [class~="print:hidden"] { display: none !important; }
.company-print-heading { display: block; }
.company-print-article { position: static !important; width: 100%; max-width: none !important; margin: 0 !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
.company-print-article h1, .company-print-article h2 { break-after: avoid; }
@page { margin: 1.5cm; }
}`}</style>
          <article
            className="company-print-article surface-card mx-auto max-w-4xl space-y-5 break-words"
            id="company-print-content"
          >
            <h1 className="company-print-heading text-2xl font-bold">
              {title}
            </h1>
            {draftPreview ? (
              <section
                className="rounded-xl border border-amber-200 bg-amber-50 p-4"
                aria-label={tr('Draft review', 'مراجعة المسودة')}
              >
                <h2 className="font-semibold">
                  {tr(
                    'Review saved draft before publishing',
                    'مراجعة المسودة المحفوظة قبل النشر',
                  )}
                </h2>
                <p className="mt-2 text-sm leading-6">
                  {tr(
                    'Check the wording, attachment, audience and sharing settings below. Publishing approves this exact saved revision. If another edit is saved, publication will stop until you review it again.',
                    'راجع النص والمرفق والأدوار وصلاحية المشاركة أدناه. يعتمد النشر هذه المراجعة المحفوظة تحديداً. إذا حُفظ تعديل آخر، يتوقف النشر حتى تراجعه مجدداً.',
                  )}
                </p>
              </section>
            ) : null}
            {historical ? (
              <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <h2 className="font-semibold">
                  {tr(
                    'Older version — not the current instructions',
                    'نسخة سابقة — ليست التعليمات الحالية',
                  )}
                </h2>
                <Link
                  className="mt-2 inline-block text-sm font-semibold underline print:hidden"
                  href={`/company/items/${record.id}`}
                >
                  {tr(
                    'View current published version',
                    'عرض النسخة المنشورة الحالية',
                  )}{' '}
                  · v{latestVersion}
                </Link>
              </section>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="rounded-full border px-3 py-1">
                {record.archived
                  ? tr('Archived', 'مؤرشف')
                  : draftPreview
                    ? `${tr('Draft revision', 'مراجعة المسودة')} ${record.revision}`
                    : record.current_version > 0
                      ? `${tr('Published version', 'النسخة المنشورة')} ${record.current_version}`
                      : tr(
                          'Private draft — not a company rule',
                          'مسودة خاصة — ليست قاعدة معتمدة',
                        )}
              </span>
              <span>
                {record.data.external_shareable
                  ? draftPreview
                    ? tr(
                        'Proposed: external sharing',
                        'مقترح: المشاركة الخارجية',
                      )
                    : tr(
                        'Approved for external sharing',
                        'معتمد للمشاركة الخارجية',
                      )
                  : tr('Internal use only', 'للاستخدام الداخلي فقط')}
              </span>
            </div>
            <p className="text-sm text-slate-600">
              {companyText(record.data, 'summary', ar)}
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">
                  {tr('Content owner', 'مسؤول المحتوى')}
                </dt>
                <dd>{record.owner_name ?? tr('Not set', 'غير محدد')}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {tr('Review date', 'تاريخ المراجعة')}
                </dt>
                <dd>{record.data.review_date || '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {tr('Audience', 'الأدوار المعنية')}
                </dt>
                <dd>
                  {record.data.audience
                    .map((r) => companyRoleLabels[r][ar ? 1 : 0])
                    .join(ar ? '، ' : ', ')}
                </dd>
              </div>
            </dl>
            <div
              className="whitespace-pre-wrap text-base leading-8"
              dir={
                ar
                  ? record.data.body_ar
                    ? 'rtl'
                    : 'ltr'
                  : record.data.body_en
                    ? 'ltr'
                    : 'rtl'
              }
            >
              {companyText(record.data, 'body', ar)}
            </div>
            {draftPreview ? (
              <dl className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">
                    {tr('Notify selected roles', 'إشعار الأدوار المحددة')}
                  </dt>
                  <dd className="mt-1 font-medium">
                    {record.data.notify
                      ? tr('Yes — in-app update', 'نعم — تحديث داخل النظام')
                      : tr('No update notification', 'دون إشعار بالتحديث')}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    {tr('Acknowledgement', 'الإقرار بالاطلاع')}
                  </dt>
                  <dd className="mt-1 font-medium">
                    {record.data.requires_ack
                      ? tr(
                          'Required for this new version',
                          'مطلوب لهذه النسخة الجديدة',
                        )
                      : tr('Not required', 'غير مطلوب')}
                  </dd>
                </div>
              </dl>
            ) : null}
            <div className="flex flex-wrap gap-2 print:hidden">
              {record.data.file_id ? (
                <>
                  <a
                    className="btn-primary"
                    href={`/api/company/files/${record.data.file_id}`}
                  >
                    {draftPreview
                      ? tr('Open draft attachment', 'فتح مرفق المسودة')
                      : tr('Download this version', 'تنزيل هذه النسخة')}
                  </a>
                  <a
                    className="btn-secondary"
                    href={`/api/company/files/${record.data.file_id}?preview=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {tr('Preview / open file', 'معاينة / فتح الملف')}
                  </a>
                </>
              ) : null}
              {record.data.source_url ? (
                <a
                  className="btn-secondary"
                  href={record.data.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tr('Open editable master', 'فتح الأصل القابل للتعديل')}
                </a>
              ) : null}
              {record.data.work_path &&
              canAccessPath(profile, record.data.work_path) ? (
                <Link className="btn-secondary" href={record.data.work_path}>
                  {tr('Open related workspace', 'فتح مساحة العمل المرتبطة')}
                </Link>
              ) : null}
              <CompanyPrint ar={ar} />
            </div>
            {record.data.source_url ? (
              <p className="text-xs text-slate-500">
                {tr(
                  'The Drive master is a live link, not an immutable issued document. Access is managed in Drive. Previously sent proposals and signed agreements stay on their business records.',
                  'أصل Drive رابط متغير وليس وثيقة نهائية ثابتة. تُدار صلاحياته في Drive. تبقى العروض السابقة والاتفاقيات الموقعة في سجلاتها.',
                )}
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              {tr(
                'Printed copy: check the current published version in Snacky OS before use.',
                'نسخة مطبوعة: تحقق من النسخة المنشورة الحالية في نظام سناكي قبل الاستخدام.',
              )}{' '}
              /company/items/{record.id} ·{' '}
              {draftPreview
                ? `draft r${record.revision}`
                : `v${record.current_version}`}
            </p>
          </article>
          {record.current_version > 0 && !record.archived && !draftPreview ? (
            <section className="surface-card space-y-3 print:hidden">
              <h2 className="font-semibold">
                {tr('Your reading status', 'حالة اطلاعك')}
              </h2>
              <p className="text-sm">
                {record.ack_at
                  ? tr(
                      'You acknowledged this exact version.',
                      'أقررت بالاطلاع على هذه النسخة المحددة.',
                    )
                  : record.read_at
                    ? tr(
                        'Marked as read. This does not acknowledge a required policy or complete any task.',
                        'سُجلت القراءة. هذا لا يُعد إقراراً بسياسة مطلوبة ولا يُنهي أي مهمة.',
                      )
                    : tr(
                        'Opening this page does not automatically acknowledge its contents.',
                        'فتح الصفحة لا يسجّل إقراراً تلقائياً بمحتواها.',
                      )}
              </p>
              <div className="flex flex-wrap gap-3">
                {!record.read_at ? (
                  <CompanyAction
                    key={`read:${record.id}:${record.current_version}`}
                    userId={profile.id}
                    action="read"
                    itemId={record.id}
                    revision={record.revision}
                    version={record.current_version}
                    ar={ar}
                    label={tr('Mark as read', 'تسجيل الاطلاع')}
                  />
                ) : null}
                {!historical &&
                record.data.requires_ack &&
                !record.ack_at &&
                hasAnyRole(profile, record.data.audience) ? (
                  <CompanyAction
                    key={`ack:${record.id}:${record.current_version}`}
                    userId={profile.id}
                    action="ack"
                    itemId={record.id}
                    revision={record.revision}
                    version={record.current_version}
                    ar={ar}
                    label={tr(
                      'I acknowledge this version',
                      'أقرّ بالاطلاع على هذه النسخة',
                    )}
                    confirm
                  />
                ) : null}
              </div>
            </section>
          ) : null}
          {manager ? (
            <section className="surface-card space-y-4 print:hidden">
              <h2 className="font-semibold">
                {tr('Management controls', 'أدوات الإدارة')}
              </h2>
              <p className="text-sm text-slate-600">
                {tr(
                  'Edits are saved as drafts. Publishing creates an immutable version; changing a required procedure requires a new acknowledgement.',
                  'تُحفظ التعديلات كمسودات. ينشئ النشر نسخة ثابتة، وتحتاج النسخة الجديدة من الإجراء المطلوب إلى إقرار جديد.',
                )}
              </p>
              <div className="flex flex-wrap gap-3">
                {!record.archived ? (
                  <>
                    <Link
                      className="btn-secondary"
                      href={`/company/items/${record.id}?edit=1`}
                    >
                      {tr('Edit latest draft', 'تعديل أحدث مسودة')}
                    </Link>
                    {draftPreview ? (
                      <CompanyAction
                        key={`publish:${record.revision}`}
                        userId={profile.id}
                        action="publish"
                        itemId={record.id}
                        revision={record.revision}
                        version={record.current_version}
                        ar={ar}
                        label={tr(
                          'Publish this reviewed revision',
                          'نشر هذه المراجعة بعد الاطلاع',
                        )}
                        confirm
                      />
                    ) : (
                      <Link
                        className="btn-primary"
                        href={`/company/items/${record.id}?draft=1`}
                      >
                        {tr(
                          'Review saved draft for publication',
                          'مراجعة المسودة المحفوظة للنشر',
                        )}
                      </Link>
                    )}
                  </>
                ) : null}
                <CompanyAction
                  key={`archive:${record.revision}`}
                  userId={profile.id}
                  action={record.archived ? 'restore' : 'archive'}
                  itemId={record.id}
                  revision={record.revision}
                  version={record.current_version}
                  ar={ar}
                  label={
                    record.archived
                      ? tr('Restore', 'استعادة')
                      : tr('Archive', 'أرشفة')
                  }
                  confirm
                />
              </div>
              {record.current_version > 0 && !draftPreview ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    {tr(
                      'Reading and acknowledgements for this version',
                      'الاطلاع والإقرارات لهذه النسخة',
                    )}
                  </summary>
                  <p className="my-2 text-xs text-slate-500">
                    {tr(
                      'Based on current role assignments, with recorded receipts retained for people who left or changed role. Not a payroll or task-completion report.',
                      'حسب الأدوار الحالية مع الاحتفاظ بالإقرارات المسجلة لمن غادر أو تغير دوره. ليس تقرير مرتبات أو إنجاز مهام.',
                    )}
                  </p>
                  <div className="space-y-2">
                    {data.acknowledgements.map((r, index) => (
                      <div
                        className="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm"
                        key={`${r.name}:${index}`}
                      >
                        <span>
                          {r.name}
                          {!r.active ? ` · ${tr('Inactive', 'غير نشط')}` : ''}
                        </span>
                        <span>
                          {r.ack_at
                            ? tr('Acknowledged', 'أقرّ بالاطلاع')
                            : r.read_at
                              ? tr('Read only', 'اطّلع فقط')
                              : tr('Not read', 'لم يطّلع')}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </section>
          ) : null}
          {data.history.length > 0 ? (
            <details className="surface-card print:hidden">
              <summary className="cursor-pointer font-medium">
                {tr('Published version history', 'سجل النسخ المنشورة')}
              </summary>
              <div className="mt-3 space-y-2">
                {data.history.map((h) => (
                  <Link
                    className="block break-words text-sm underline"
                    key={h.version}
                    href={`/company/items/${record.id}?version=${h.version}`}
                  >
                    v{h.version} ·{' '}
                    {ar ? h.title_ar || h.title_en : h.title_en || h.title_ar} ·{' '}
                    {h.published_at.slice(0, 10)}
                  </Link>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <>
          {section === 'manage' ? (
            <details className="surface-card" open={!data.total}>
              <summary className="cursor-pointer font-semibold">
                {tr(
                  'Starter templates — create a draft, review, then publish',
                  'قوالب أولية — أنشئ مسودة ثم راجعها وانشرها',
                )}
              </summary>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {companyTemplates.map((t) => (
                  <Link
                    key={t.key}
                    className="rounded-xl border p-4 text-sm font-medium hover:bg-slate-50"
                    href={`/company/new?template=${t.key}`}
                  >
                    {ar ? t.ar : t.en}
                  </Link>
                ))}
              </div>
            </details>
          ) : null}
          <form
            method="get"
            action={`/company/${section}`}
            className="surface-card flex flex-wrap items-end gap-3"
          >
            {filters.work_path ? (
              <input type="hidden" name="work_path" value={filters.work_path} />
            ) : null}
            <label className="min-w-0 flex-1 text-sm">
              {tr(
                'Search titles, instructions or purpose',
                'البحث في العناوين والتعليمات والغرض',
              )}
              <input
                name="q"
                defaultValue={filters.q ?? ''}
                maxLength={200}
                className="field-input mt-1"
              />
            </label>
            {manager && section === 'manage' ? (
              <label className="text-sm">
                {tr('Status', 'الحالة')}
                <select
                  name="state"
                  defaultValue={filters.state ?? ''}
                  className="field-input mt-1"
                >
                  <option value="">{tr('All', 'الكل')}</option>
                  <option value="draft">
                    {tr('Unpublished drafts', 'مسودات غير منشورة')}
                  </option>
                  <option value="review">
                    {tr('Review due', 'حان موعد المراجعة')}
                  </option>
                  <option value="archived">{tr('Archived', 'مؤرشف')}</option>
                </select>
              </label>
            ) : null}
            <button className="btn-secondary" type="submit">
              {tr('Search', 'بحث')}
            </button>
          </form>
          {data.rows.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.rows.map((row) => (
                <Link
                  key={row.id}
                  href={`/company/items/${row.id}${section === 'manage' && row.has_unpublished_changes ? '?draft=1' : ''}`}
                  className="surface-card block min-w-0 space-y-3 hover:border-slate-400"
                >
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <span>
                      {row.archived
                        ? tr('Archived', 'مؤرشف')
                        : row.current_version
                          ? `v${row.current_version}`
                          : tr('Draft', 'مسودة')}
                    </span>
                    <span>
                      {row.data.external_shareable
                        ? tr('Shareable', 'للمشاركة الخارجية')
                        : tr('Internal', 'داخلي')}
                    </span>
                    {section === 'documents' ? (
                      <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-700">
                        {
                          companyDocumentCategoryLabels[
                            companyDocumentCategory(row.data)
                          ][ar ? 1 : 0]
                        }
                      </span>
                    ) : null}
                    {manager && row.has_unpublished_changes ? (
                      <span className="font-semibold text-amber-800">
                        {tr('Unpublished changes', 'تعديلات غير منشورة')}
                      </span>
                    ) : null}
                    {row.current_version > 0 &&
                    row.data.requires_ack &&
                    !row.ack_at ? (
                      <span className="font-semibold text-amber-800">
                        {tr('Acknowledgement required', 'الإقرار مطلوب')}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="break-words font-semibold">
                    {companyText(row.data, 'title', ar)}
                  </h2>
                  <p className="break-words text-sm text-slate-600">
                    {companyText(row.data, 'summary', ar)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {tr('Owner', 'المسؤول')}: {row.owner_name ?? '—'}
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <section className="surface-card py-8 text-center">
              <h2 className="font-semibold">
                {section === 'updates'
                  ? tr(
                      'No outstanding updates for your role',
                      'لا توجد تحديثات معلقة لدورك',
                    )
                  : tr(
                      'No matching materials available',
                      'لا توجد مواد مطابقة متاحة',
                    )}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {section === 'updates'
                  ? tr(
                      'Your work tasks remain in My Work. Reading is not task completion.',
                      'تبقى مهامك في عملي اليوم. الاطلاع لا يُنهي المهام.',
                    )
                  : manager
                    ? tr(
                        'Add a real file or review a starter draft. Nothing is automatically approved.',
                        'أضف ملفاً حقيقياً أو راجع مسودة أولية. لا يُعتمد أي محتوى تلقائياً.',
                      )
                    : tr(
                        'Only published materials for your roles appear here. Ask your manager about missing instructions.',
                        'تظهر هنا المواد المنشورة لأدوارك فقط. اسأل المسؤول عن التعليمات الناقصة.',
                      )}
              </p>
            </section>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              {data.total} {tr(data.total === 1 ? 'material' : 'materials', 'مادة')}
            </span>
            <div className="flex gap-2">
              {data.offset > 0 ? (
                <Link
                  className="btn-secondary"
                  href={pageHref(Math.max(0, data.offset - 20))}
                >
                  {tr('Previous', 'السابق')}
                </Link>
              ) : null}
              {data.offset + data.rows.length < data.total ? (
                <Link
                  className="btn-secondary"
                  href={pageHref(data.offset + 20)}
                >
                  {tr('Next', 'التالي')}
                </Link>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
