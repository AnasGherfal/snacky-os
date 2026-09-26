'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  companyFileLimit,
  companyRoles,
  companyRoleLabels,
  companyDocumentCategories,
  companyDocumentCategory,
  companyDocumentCategoryLabels,
  companyWorkPaths,
  companyWorkLabel,
  validateCompanyContent,
  validCompanyCommand,
  type CompanyContent,
  type CompanyCommand,
} from '@/lib/company-hub';
type Reply = {
  ok?: boolean;
  request_id?: string;
  id?: string;
  message?: string;
  retryable?: boolean;
};
export async function submitCompanyCommand(
  command: CompanyCommand,
): Promise<Reply> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('/api/company/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    const reply = (await response.json()) as Reply;
    if (
      reply.ok &&
      (reply.request_id !== command.request_id || reply.id !== command.item_id)
    )
      throw new Error('Unconfirmed response');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}
export function CompanyAction({
  action,
  itemId,
  revision,
  version,
  userId,
  ar,
  label,
  confirm = false,
}: {
  action: CompanyCommand['action'];
  itemId: string;
  revision: number;
  version: number;
  userId: string;
  ar: boolean;
  label: string;
  confirm?: boolean;
}) {
  const router = useRouter(),
    busy = useRef(false),
    request = useRef<CompanyCommand | null>(null),
    [pending, setPending] = useState(false),
    [done, setDone] = useState(false),
    [message, setMessage] = useState('');
  const key = `snacky:company:command:${userId}:${itemId}:${action}:${revision}:${version}`;
  async function run() {
    if (busy.current || done) return;
    if (
      confirm &&
      !request.current &&
      !window.confirm(
        action === 'ack'
          ? ar
            ? 'أؤكد أنني اطّلعت على هذه النسخة وفهمت المطلوب.'
            : 'I confirm I have read this version and understand what is required.'
          : ar
            ? 'هل تؤكد هذا الإجراء على المحتوى؟'
            : 'Confirm this content action?',
      )
    )
      return;
    busy.current = true;
    setPending(true);
    setMessage('');
    try {
      if (!request.current) {
        const saved = sessionStorage.getItem(key);
        request.current = saved
          ? validCompanyCommand(JSON.parse(saved))
          : {
              request_id: crypto.randomUUID(),
              action,
              item_id: itemId,
              revision,
              version,
            };
        if (
          request.current.item_id !== itemId ||
          request.current.action !== action ||
          request.current.revision !== revision ||
          request.current.version !== version
        )
          throw new Error('Saved request does not match');
        sessionStorage.setItem(key, JSON.stringify(request.current));
      }
      const reply = await submitCompanyCommand(request.current);
      if (reply.ok) {
        setDone(true);
        sessionStorage.removeItem(key);
        request.current = null;
        setMessage(ar ? 'تم الحفظ.' : 'Saved.');
        window.dispatchEvent(new Event('snacky-company-updated'));
        if (action === 'publish') router.push(`/company/items/${itemId}`);
        router.refresh();
      } else {
        setMessage(
          reply.message ??
            (ar ? 'تعذر التأكيد. أعد المحاولة.' : 'Could not confirm. Retry.'),
        );
        if (reply.retryable === false) {
          sessionStorage.removeItem(key);
          request.current = null;
        }
      }
    } catch {
      setMessage(
        ar
          ? 'لم يتأكد الحفظ. أعد المحاولة لإرسال نفس الطلب دون تكرار.'
          : 'Save unconfirmed. Retry to send the same request without duplicating it.',
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-secondary min-h-11"
        disabled={pending || done}
        onClick={() => void run()}
      >
        {pending ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : label}
      </button>
      {message ? (
        <p role="status" className="max-w-lg text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
export function CompanyEditor({
  initial,
  itemId,
  revision,
  userId,
  directory,
  ar,
}: {
  initial: CompanyContent;
  itemId: string;
  revision: number;
  userId: string;
  directory: { id: string; name: string }[];
  ar: boolean;
}) {
  const router = useRouter(),
    [content, setContent] = useState(initial),
    [language, setLanguage] = useState<'en' | 'ar'>(ar ? 'ar' : 'en'),
    [message, setMessage] = useState(''),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [corrupt, setCorrupt] = useState(false),
    [uploading, setUploading] = useState(false);
  const busy = useRef(false),
    pending = useRef<CompanyCommand | null>(null),
    key = `snacky:company:draft:${userId}:${itemId}`,
    tr = (en: string, arabic: string) => (ar ? arabic : en);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const cmd = validCompanyCommand(JSON.parse(raw));
        if (cmd.item_id !== itemId || cmd.action !== 'save' || !cmd.payload)
          throw Error('Wrong draft');
        pending.current = cmd;
        setContent(cmd.payload);
        setUncertain(true);
      }
    } catch {
      setCorrupt(true);
    }
  }, [key, itemId]);
  function set<K extends keyof CompanyContent>(k: K, v: CompanyContent[K]) {
    setContent((c) => ({ ...c, [k]: v }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current || saved || corrupt || uploading) return;
    busy.current = true;
    setSaving(true);
    setMessage('');
    try {
      if (!pending.current) {
        const payload = validateCompanyContent(content);
        const cmd: CompanyCommand = {
          request_id: crypto.randomUUID(),
          item_id: itemId,
          revision,
          action: 'save',
          payload,
        };
        sessionStorage.setItem(key, JSON.stringify(cmd));
        pending.current = cmd;
      }
      setUncertain(true);
      const reply = await submitCompanyCommand(pending.current);
      if (reply.ok) {
        setSaved(true);
        sessionStorage.removeItem(key);
        pending.current = null;
        router.push(`/company/items/${itemId}?draft=1`);
        router.refresh();
      } else {
        setMessage(reply.message ?? tr('Could not save.', 'تعذر الحفظ.'));
        if (reply.retryable === false) {
          sessionStorage.removeItem(key);
          pending.current = null;
          setUncertain(false);
        }
      }
    } catch (error) {
      setMessage(
        pending.current
          ? tr(
              'Save unconfirmed. Retry the saved request; your exact content is retained in this browser session.',
              'لم يتأكد الحفظ. أعد إرسال الطلب المحفوظ؛ المحتوى نفسه محفوظ في جلسة المتصفح.',
            )
          : error instanceof Error
            ? error.message
            : tr(
                'Browser storage is unavailable. Enable it before saving.',
                'تخزين المتصفح غير متاح. فعّله قبل الحفظ.',
              ),
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file || uncertain || busy.current) return;
    if (file.size > companyFileLimit) {
      setMessage(
        tr(
          'Use a file under 4 MB or a Drive link for larger masters.',
          'استخدم ملفاً دون 4 ميغابايت أو رابط Drive للملفات الأكبر.',
        ),
      );
      return;
    }
    setUploading(true);
    setMessage('');
    try {
      const bytes = await file.arrayBuffer(),
        hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
      const uploadKey = `snacky:company:upload:${userId}:${hash}:${file.name}`;
      const id = sessionStorage.getItem(uploadKey) ?? crypto.randomUUID();
      sessionStorage.setItem(uploadKey, id);
      const data = new FormData();
      data.set('id', id);
      data.set('file', file);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        response = await fetch('/api/company/files', {
          method: 'POST',
          body: data,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const reply = await response.json();
      if (!response.ok || !reply.ok || reply.id !== id)
        throw Error(
          reply.message ?? 'Upload unconfirmed. Select the same file to retry.',
        );
      set('file_id', id);
      setMessage(
        tr(
          `Attached: ${file.name}. Save the draft to retain this attachment.`,
          `تم إرفاق: ${file.name}. احفظ المسودة للاحتفاظ بالمرفق.`,
        ),
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : tr(
              'Upload unconfirmed. Select the same file again to retry.',
              'لم يتأكد الرفع. اختر الملف نفسه مجدداً للمحاولة.',
            ),
      );
    } finally {
      setUploading(false);
    }
  }
  const textKey = (field: 'title' | 'summary' | 'body') =>
    `${field}_${language}` as keyof Pick<
      CompanyContent,
      | 'title_en'
      | 'title_ar'
      | 'summary_en'
      | 'summary_ar'
      | 'body_en'
      | 'body_ar'
    >;
  return (
    <form onSubmit={save} className="space-y-5" dir={ar ? 'rtl' : 'ltr'}>
      <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
        {tr(
          'Save creates a private draft. Publication is a separate management action. Do not place salaries, contracts or private employee files here.',
          'الحفظ ينشئ مسودة خاصة. النشر إجراء إداري منفصل. لا تضع هنا المرتبات أو العقود أو ملفات الموظفين الخاصة.',
        )}
      </p>
      {corrupt ? (
        <p role="alert">
          {tr(
            'A saved request is invalid. Do not create another copy; ask your administrator to review the existing record.',
            'الطلب المحفوظ غير صالح. لا تنشئ نسخة أخرى؛ اطلب من المسؤول مراجعة السجل الموجود.',
          )}
        </p>
      ) : null}
      {uncertain ? (
        <p role="status">
          {tr(
            'A saved request is pending. Retry it before changing this content.',
            'يوجد طلب محفوظ قيد التأكيد. أعد إرساله قبل تعديل المحتوى.',
          )}
        </p>
      ) : null}
      <fieldset
        disabled={saving || saved || uncertain || corrupt || uploading}
        className="space-y-5 disabled:opacity-70"
      >
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={tr('Editing language', 'لغة التحرير')}
        >
          <button
            type="button"
            className={language === 'ar' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setLanguage('ar')}
          >
            العربية
          </button>
          <button
            type="button"
            className={language === 'en' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setLanguage('en')}
          >
            English
          </button>
        </div>
        <label className="block text-sm font-medium">
          {tr('Title', 'العنوان')}
          <input
            className="field-input mt-1"
            dir={language === 'ar' ? 'rtl' : 'ltr'}
            maxLength={160}
            value={content[textKey('title')]}
            onChange={(e) => set(textKey('title'), e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          {tr('What is this for?', 'ما الغرض من هذا المحتوى؟')}
          <textarea
            className="field-input mt-1"
            dir={language === 'ar' ? 'rtl' : 'ltr'}
            rows={2}
            maxLength={600}
            value={content[textKey('summary')]}
            onChange={(e) => set(textKey('summary'), e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          {tr(
            'Instructions / responsibilities (plain text)',
            'التعليمات / المسؤوليات (نص عادي)',
          )}
          <textarea
            className="field-input mt-1"
            dir={language === 'ar' ? 'rtl' : 'ltr'}
            rows={12}
            maxLength={20000}
            value={content[textKey('body')]}
            onChange={(e) => set(textKey('body'), e.target.value)}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            {tr('Section', 'القسم')}
            <select
              className="field-input mt-1"
              value={content.section}
              onChange={(e) =>
                set('section', e.target.value as CompanyContent['section'])
              }
            >
              {[
                ['start', 'Start Here', 'ابدأ هنا'],
                ['guides', 'How We Work', 'كيف نعمل'],
                ['documents', 'Documents & Brand', 'الوثائق والهوية'],
                ['people', 'Responsibilities', 'المسؤوليات'],
              ].map(([v, en, arabic]) => (
                <option key={v} value={v}>
                  {tr(en, arabic)}
                </option>
              ))}
            </select>
          </label>
          {content.section === 'documents' ? (
            <label className="text-sm">
              {tr('Library category', 'تصنيف المكتبة')}
              <select
                className="field-input mt-1"
                value={companyDocumentCategory(content)}
                onChange={(e) =>
                  set(
                    'document_category',
                    e.target.value as CompanyContent['document_category'],
                  )
                }
              >
                {companyDocumentCategories.map((category) => (
                  <option key={category} value={category}>
                    {companyDocumentCategoryLabels[category][ar ? 1 : 0]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-sm">
            {tr('Content owner', 'مسؤول المحتوى')}
            <select
              className="field-input mt-1"
              value={content.owner_id}
              onChange={(e) => set('owner_id', e.target.value)}
            >
              <option value="">{tr('Choose an owner', 'اختر مسؤولاً')}</option>
              {directory.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            {tr('Next review date', 'تاريخ المراجعة القادمة')}
            <input
              className="field-input mt-1"
              type="date"
              value={content.review_date}
              onChange={(e) => set('review_date', e.target.value)}
            />
          </label>
          <label className="text-sm">
            {tr('Related working screen', 'شاشة العمل المرتبطة')}
            <select
              className="field-input mt-1"
              value={content.work_path}
              onChange={(e) => set('work_path', e.target.value)}
            >
              <option value="">{tr('None', 'لا يوجد')}</option>
              {companyWorkPaths.map((path) => (
                <option key={path} value={path}>
                  {companyWorkLabel(path, ar)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="rounded-xl border p-4">
          <legend className="px-2 text-sm font-semibold">
            {tr('Who should see it?', 'من يمكنه الاطلاع؟')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {companyRoles.map((role) => (
              <label className="flex items-start gap-2 text-sm" key={role}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={content.audience.includes(role)}
                  onChange={(e) =>
                    set(
                      'audience',
                      e.target.checked
                        ? [...content.audience, role]
                        : content.audience.filter((r) => r !== role),
                    )
                  }
                />
                {companyRoleLabels[role][ar ? 1 : 0]}
              </label>
            ))}
          </div>
        </fieldset>
        <details
          className="rounded-xl border p-4"
          open={content.section === 'documents'}
        >
          <summary className="cursor-pointer font-medium">
            {tr('File or editable master', 'الملف أو الأصل القابل للتعديل')}
          </summary>
          <div className="mt-3 space-y-4">
            <label className="block text-sm">
              {tr(
                'Upload a new file (maximum 4 MB)',
                'رفع ملف جديد (4 ميغابايت كحد أقصى)',
              )}
              <input
                className="mt-2 block w-full text-sm"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.svg,.docx,.pptx,.xlsx"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
            </label>
            {content.file_id ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <a
                  className="underline"
                  href={`/api/company/files/${content.file_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tr('View attached file', 'عرض الملف المرفق')}
                </a>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => set('file_id', '')}
                >
                  {tr('Remove from this draft', 'إزالة من هذه المسودة')}
                </button>
              </div>
            ) : null}
            <label className="block text-sm">
              {tr(
                'Google Drive / Docs master link',
                'رابط الأصل في Google Drive / Docs',
              )}
              <input
                className="field-input mt-1"
                dir="ltr"
                type="url"
                value={content.source_url}
                onChange={(e) => set('source_url', e.target.value)}
              />
            </label>
            <p className="text-xs text-slate-500">
              {tr(
                'A Drive link does not grant access. Set permissions in Drive. Attach final issued documents to their lead/location records, not to this reusable library.',
                'رابط Drive لا يمنح صلاحية الوصول. اضبط الصلاحيات في Drive. أرفق الوثائق النهائية الصادرة بسجل الجهة أو الموقع، وليس بمكتبة القوالب.',
              )}
            </p>
          </div>
        </details>
        <fieldset className="space-y-3 rounded-xl border p-4">
          <legend className="px-2 text-sm font-semibold">
            {tr('Publication options', 'خيارات النشر')}
          </legend>
          {(
            [
              [
                'external_shareable',
                'Approved for external sharing',
                'معتمد للمشاركة خارج الشركة',
              ],
              [
                'notify',
                'Notify these roles about this version',
                'إشعار هذه الأدوار بهذه النسخة',
              ],
              [
                'requires_ack',
                'Require explicit acknowledgement of this version',
                'طلب إقرار صريح بالاطلاع على هذه النسخة',
              ],
            ] as const
          ).map(([key, en, arabic]) => (
            <label className="flex items-start gap-2 text-sm" key={key}>
              <input
                className="mt-1"
                type="checkbox"
                checked={content[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
              {tr(en, arabic)}
            </label>
          ))}
        </fieldset>
      </fieldset>
      {message ? (
        <p role="status" className="rounded-xl border p-3 text-sm">
          {message}
        </p>
      ) : null}
      <button
        type="submit"
        className="btn-primary min-h-11"
        disabled={saving || saved || uploading || corrupt}
      >
        {uploading
          ? tr('Uploading…', 'جارٍ الرفع…')
          : saving
            ? tr('Saving…', 'جارٍ الحفظ…')
            : uncertain
              ? tr('Retry saved request', 'إعادة إرسال الطلب المحفوظ')
              : tr('Save draft', 'حفظ المسودة')}
      </button>
    </form>
  );
}
export function CompanyPrint({ ar }: { ar: boolean }) {
  return (
    <button
      type="button"
      className="btn-secondary print:hidden"
      onClick={() => window.print()}
    >
      {ar ? 'طباعة هذه النسخة' : 'Print this version'}
    </button>
  );
}
