'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { proposalKit, readKitFiles, verifyKitFile, kitUuid, kitContent, bytesDigest, untouchedKitDraft, type KitState } from '@/lib/company-proposal-import';
import { validCompanyCommand, type CompanyCommand, type CompanyItem } from '@/lib/company-hub';

export function CompanyProposalImport({ ar, userId, defaultOwner, reviewDate }: { ar: boolean; userId: string; defaultOwner: string; reviewDate: string }) {
  const lock = useRef(false);
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [files, setFiles] = useState<File[]>([]), [owner, setOwner] = useState(defaultOwner), [review, setReview] = useState(reviewDate);
  const [busy, setBusy] = useState(false), [state, setState] = useState<KitState | null>(null), [message, setMessage] = useState('');
  const [progress, setProgress] = useState<Record<string, string>>({});
  const update = (name: string, value: string) => setProgress(old => ({ ...old, [name]: value }));
  async function status(): Promise<KitState> {
    const r = await fetch('/api/company/proposal-kit', { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const body = await r.json();
    if (!r.ok || body.ok !== true || body.data.user_id !== userId) throw Error(tr('Could not verify the library or your session. Sign in as owner/admin and retry.', 'تعذر التحقق من المكتبة أو الجلسة. سجّل دخول المالك/الإدارة وأعد المحاولة.'));
    setState(body.data); return body.data;
  }
  async function choose(selected: File[]) {
    setBusy(true); setMessage(''); setFiles([]); setProgress({});
    try {
      const verified = await readKitFiles(selected); await status(); setFiles(verified);
      setMessage(tr(`${verified.length} exact original files verified. Nothing uploaded yet.`, `تم التحقق من ${verified.length} ملفاً أصلياً. لم تُرفع الملفات بعد.`));
    } catch { setMessage(tr('Could not verify the kit or library. Select the supplied import JSON or original PDF/PPTX files and retry while signed in.', 'تعذر التحقق من الحزمة أو المكتبة. اختر ملف JSON المرفق أو ملفات PDF/PPTX الأصلية وأعد المحاولة بعد تسجيل الدخول.')); }
    finally { setBusy(false); }
  }
  async function command(input: Omit<CompanyCommand, 'request_id'>) {
    // Stable, actor-bound command IDs allow exact retries without persisting credentials or file bytes.
    const digest = await bytesDigest(new TextEncoder().encode(JSON.stringify({ userId, ...input })).buffer);
    const request = validCompanyCommand({ ...input, request_id: kitUuid(digest, 'file') });
    const r = await fetch('/api/company/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(45000) });
    const body = await r.json();
    if (!r.ok || body.ok !== true || body.id !== request.item_id || body.request_id !== request.request_id || !Number.isSafeInteger(body.revision)) throw Error(tr('Save not confirmed. Retry this kit; existing records will not be overwritten.', 'لم يتأكد الحفظ. أعد استيراد الحزمة؛ لن تُستبدل السجلات الموجودة.'));
    return body as { revision: number; version: number };
  }
  async function verifyDownload(id: string, digest: string) {
    const r = await fetch(`/api/company/files/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(45000) });
    if (!r.ok || await bytesDigest(await r.arrayBuffer()) !== digest) throw Error(tr('The stored file could not be verified. No publication was confirmed.', 'تعذر التحقق من الملف المخزن. لم يُؤكَّد النشر.'));
  }
  async function importFiles() {
    if (lock.current || busy || !files.length || !owner || !review) return;
    lock.current = true;
    setBusy(true); setMessage('');
    try {
      const current = await status();
      if (!current.directory.some(x => x.id === owner)) throw Error(tr('Choose an active content owner.', 'اختر مسؤول محتوى نشطاً.'));
      for (const file of files) {
        const entry = await verifyKitFile(file), fileId = kitUuid(entry.digest, 'file'), itemId = kitUuid(entry.digest, 'item');
        const registered = current.files.find(x => x.id === fileId);
        let record = current.records.find(x => x.id === itemId);
        if (registered && registered.digest !== entry.digest) throw Error('File identity conflict.');
        if (record && (record.archived || record.data.file_id !== fileId)) throw Error(tr('An existing record changed. Review it in the library instead of replacing it.', 'تغير سجل موجود. راجعه في المكتبة بدلاً من استبداله.'));
        update(file.name, tr('Uploading and verifying…', 'جارٍ الرفع والتحقق…'));
        if (!registered) {
          const form = new FormData(); form.set('id', fileId); form.set('file', file, entry.name);
          const r = await fetch('/api/company/files', { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
          const body = await r.json();
          if (!r.ok || body.ok !== true || body.id !== fileId) throw Error(tr('Upload not confirmed. Retry the same kit.', 'لم يتأكد الرفع. أعد استيراد الحزمة نفسها.'));
        }
        await verifyDownload(fileId, entry.digest);
        if (record?.current_version) { update(file.name, tr('Already available; unchanged', 'متاح بالفعل؛ دون تغيير')); continue; }
        if (!record) {
          const content = kitContent(entry, owner, review);
          const saved = await command({ action: 'save', item_id: itemId, revision: 0, payload: content });
          record = { id: itemId, revision: saved.revision, current_version: 0, archived: false, data: content } as CompanyItem;
        }
        if (!untouchedKitDraft(record, entry)) throw Error(tr('This draft has been edited. Review and publish it manually; the import will not overwrite it.', 'عُدّلت هذه المسودة. راجعها وانشرها من سجلها؛ لن يستبدلها الاستيراد.'));
        update(file.name, tr('Publishing for internal use…', 'جارٍ الإتاحة للاستخدام الداخلي…'));
        const published = await command({ action: 'publish', item_id: itemId, revision: record.revision });
        if (!Number.isSafeInteger(published.version) || published.version < 1) throw Error('Publication not confirmed.');
        update(file.name, tr('Published internally; verifying record…', 'نُشر داخلياً؛ جارٍ التحقق من السجل…'));
      }
      const final = await status();
      for (const file of files) {
        const entry = proposalKit.find(x => x.name === file.name)!;
        const row = final.records.find(x => x.id === kitUuid(entry.digest, 'item'));
        if (!row || row.archived || row.current_version < 1 || row.data.file_id !== kitUuid(entry.digest, 'file')) throw Error(tr('Publication is not fully confirmed. Retry to verify the remaining records.', 'لم يكتمل تأكيد النشر. أعد المحاولة للتحقق من السجلات المتبقية.'));
        update(file.name, tr('Verified in the library', 'تم التحقق منه في المكتبة'));
      }
      setMessage(tr(`Completed: ${files.length} actual files are available in the internal library.`, `اكتمل الاستيراد: ${files.length} ملفاً فعلياً متاحة في المكتبة الداخلية.`));
    } catch (e) { setMessage((e instanceof Error ? e.message : 'Import not confirmed.') + ' ' + tr('Already completed files are retained. Select the same kit again to resume.', 'الملفات المكتملة محفوظة. اختر الحزمة نفسها مجدداً للاستكمال.')); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div dir={ar ? 'rtl' : 'ltr'} className="mx-auto max-w-4xl space-y-5">
    <header><h1 className="text-2xl font-semibold">{tr('Add the prepared Snacky documents', 'إضافة مستندات سناكي الجاهزة')}</h1><p className="mt-2 text-sm leading-7 text-slate-600">{tr('One selection adds the original PDFs and editable masters through the existing private upload and publishing workflow. No replacement artwork, public storage or new passwords.', 'اختيار واحد يضيف ملفات PDF الأصلية والأصول القابلة للتعديل عبر مسار الرفع والنشر الخاص الحالي. لا ملفات بديلة ولا تخزين عام ولا كلمات مرور جديدة.')}</p></header>
    <section className="surface-card space-y-4">
      <label className="block text-sm font-semibold">{tr('Choose Snacky-Documents-Import.json or the original files', 'اختر Snacky-Documents-Import.json أو الملفات الأصلية')}<input className="mt-2 block w-full min-w-0 text-sm" type="file" multiple accept=".json,.pdf,.pptx" disabled={busy} onChange={e => choose(Array.from(e.target.files ?? []))}/></label>
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">{tr('Content owner', 'مسؤول المحتوى')}<select className="field-input mt-1 w-full" disabled={busy || !state} value={owner} onChange={e => setOwner(e.target.value)}><option value="">{tr('Choose active owner', 'اختر مسؤولاً نشطاً')}</option>{state?.directory.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label className="text-sm">{tr('Review date', 'تاريخ المراجعة')}<input className="field-input mt-1 w-full" type="date" disabled={busy} value={review} onChange={e => setReview(e.target.value)}/></label></div>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-7 text-amber-950">{tr('The new kit is made available to CRM and management for internal preparation. The two earlier reference PDFs stay management-only. No file receives external-sharing approval automatically, and the earlier approved profile record is not replaced.', 'تُتاح الحزمة الجديدة لعلاقات العملاء والإدارة للإعداد الداخلي. يظل ملفا المرجع السابقان للإدارة فقط. لا يُعتمد أي ملف للمشاركة الخارجية تلقائياً، ولا يُستبدل سجل الملف التعريفي المعتمد السابق.')}</p>
      <button className="btn-primary min-h-11" disabled={busy || !files.length || !owner || !review} onClick={importFiles}>{busy ? tr('Working…', 'جارٍ التنفيذ…') : tr('Add files to the internal library', 'إضافة الملفات إلى المكتبة الداخلية')}</button>
      {message ? <p role="status" className="text-sm leading-7">{message}</p> : null}
    </section>
    <section className="surface-card"><h2 className="font-semibold">{tr('Original files in this kit', 'الملفات الأصلية في الحزمة')}</h2><div className="mt-3 divide-y">{proposalKit.map(entry => <div key={entry.name} className="py-3"><p className="text-sm font-medium">{ar ? entry.title_ar : entry.title_en}</p><p dir="ltr" className="mt-1 break-all text-xs text-slate-500">{entry.name}</p>{progress[entry.name] ? <p className="mt-1 text-sm text-emerald-800">{progress[entry.name]}</p> : null}</div>)}</div></section>
    <Link className="btn-secondary inline-flex" href="/company/documents">{tr('Open Documents & Brand', 'فتح الوثائق والهوية')}</Link>
  </div>;
}
