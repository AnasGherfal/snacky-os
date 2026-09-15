'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/components/I18nProvider';
import { type CrmField, crmKinds, uuidPattern } from '@/lib/crm-workspace';

type RequestReceipt = { id: string; action: string; recordId: string | null; values: Record<string, string> };
type Props = {
  action: string; recordId?: string | null; userId: string; fields: CrmField[];
  hidden?: Record<string, string>; submitLabel: string; stay?: boolean;
};

function readSaved(raw: string, action: string, recordId: string | null, hidden: Record<string, string>): RequestReceipt {
  const saved = JSON.parse(raw);
  if (!saved || !uuidPattern.test(saved.id ?? '') || saved.action !== action || saved.recordId !== recordId
    || !saved.values || typeof saved.values !== 'object' || Array.isArray(saved.values)
    || Object.values(saved.values).some(value => typeof value !== 'string')
    || ['kind', 'related_id'].some(key => (saved.values[key] ?? '') !== (hidden[key] ?? ''))) {
    throw new Error('Saved request does not belong to this record.');
  }
  return saved;
}

export function CrmForm({ action, recordId = null, userId, fields, hidden = {}, submitLabel, stay = false }: Props) {
  const { locale } = useLanguage();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const router = useRouter();
  // New linked contacts/tasks must not reuse another parent record's pending request.
  const scope = `${hidden.kind ?? 'none'}:${hidden.related_id ?? 'none'}`;
  const key = `snacky:crm-command:v2:${userId}:${action}:${recordId ?? 'new'}:${scope}`;
  const defaults = () => ({ ...hidden, ...Object.fromEntries(fields.map(field => [field.name, field.value ?? ''])) });
  const [values, setValues] = useState<Record<string, string>>(defaults);
  const [saved, setSaved] = useState<RequestReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [done, setDone] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const storageAvailable = useRef(true);
  const canAddAnother = stay && (action === 'note.add' || (!recordId && ['task.save', 'contact.save'].includes(action)));

  useEffect(() => {
    setReady(false); setBlocked(false); setDone(false); setStale(false); setSaved(null); setMessage(''); setValues(defaults());
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { storageAvailable.current = false; }
    if (raw) {
      try { const receipt = readSaved(raw, action, recordId, hidden); setSaved(receipt); setValues(receipt.values); }
      catch { setBlocked(true); setMessage(tr('A saved request could not be read. Review the record before adding it again.', 'تعذر قراءة طلب محفوظ. راجع السجل قبل تكرار العملية.')); }
    }
    setReady(true);
    // Parent identity, not changing field defaults, controls saved-command scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, action, recordId]);

  function forget(id: string) {
    try { if (JSON.parse(localStorage.getItem(key) ?? 'null')?.id === id) localStorage.removeItem(key); }
    catch { storageAvailable.current = false; }
  }

  async function submit() {
    if (lock.current || !ready || blocked || done || stale) return;
    let receipt = saved;
    if (!receipt && storageAvailable.current) {
      let raw: string | null = null;
      try { raw = localStorage.getItem(key); } catch { storageAvailable.current = false; }
      if (raw) {
        try { receipt = readSaved(raw, action, recordId, hidden); }
        catch { setBlocked(true); setMessage(tr('Review the saved request first.', 'راجع الطلب المحفوظ أولاً.')); return; }
      }
    }
    receipt = receipt ?? { id: crypto.randomUUID(), action, recordId, values };
    lock.current = true; setBusy(true); setSaved(receipt); setValues(receipt.values); setMessage('');
    try { localStorage.setItem(key, JSON.stringify(receipt)); } catch { storageAvailable.current = false; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/crm/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receipt), signal: controller.signal,
      });
      const result = await response.json();
      if (result.ok === true) {
        if (result.commandId !== receipt.id || !uuidPattern.test(String(result.id ?? '')) || !crmKinds.includes(result.kind)) {
          throw new Error('Unexpected saved-command receipt.');
        }
        forget(receipt.id); setSaved(null); setDone(true); setMessage(tr('Saved in Snacky OS.', 'تم الحفظ في سناكي.'));
        if (!stay && typeof result.href === 'string' && result.href.startsWith('/') && !result.href.startsWith('//')) router.push(result.href);
        router.refresh();
      } else {
        setMessage(String(result.message ?? tr('Save not confirmed. Retry the same request.', 'لم يتم تأكيد الحفظ. أعد نفس الطلب.')));
        if (result.resetAllowed === true) { forget(receipt.id); setSaved(null); }
        if (result.refreshRequired === true) setStale(true);
      }
    } catch {
      setMessage(tr('The result is uncertain. Retry this same request to avoid duplicates.', 'النتيجة غير مؤكدة. أعد نفس الطلب لتجنب التكرار.'));
    } finally { clearTimeout(timeout); lock.current = false; setBusy(false); }
  }

  const field = (field: CrmField) => {
    const disabled = busy || Boolean(saved) || blocked || done || stale || !ready;
    const id = `${action}-${recordId ?? 'new'}-${scope}-${field.name}`;
    const props = {
      name: field.name, id, required: field.required, disabled, value: values[field.name] ?? '',
      className: 'field-input mt-1 w-full min-w-0',
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setValues(current => ({ ...current, [field.name]: event.target.value })),
    };
    return <label className={`block min-w-0 text-sm ${field.type === 'textarea' ? 'sm:col-span-2' : ''}`} key={field.name} htmlFor={id}>
      <span className="font-medium text-slate-800">{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</span>
      {field.type === 'textarea' ? <textarea {...props} rows={3} maxLength={4000} />
        : field.type === 'select' ? <select {...props}>{field.options?.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
        : field.type === 'checkbox' ? <input id={id} name={field.name} type="checkbox" required={field.required} disabled={disabled} checked={values[field.name] === 'true'} className="ms-3 size-5 align-middle" onChange={event => setValues(current => ({ ...current, [field.name]: String(event.target.checked) }))} />
        : <input {...props} type={field.type ?? 'text'} min={field.min} max={field.max} step={field.step ?? (field.type === 'number' ? '0.01' : undefined)} maxLength={field.type === 'text' ? 4000 : undefined} />}
      {field.hint ? <span className="mt-1 block text-xs leading-5 text-slate-500">{field.hint}</span> : null}
    </label>;
  };

  return <form action={submit} className="space-y-4" dir={ar ? 'rtl' : 'ltr'}>
    {message ? <p role={done ? 'status' : 'alert'} className={`rounded-lg border p-3 text-sm ${done ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-950'}`}>{message}</p> : null}
    {saved && !done ? <p className="text-sm text-amber-900">{tr('The submitted details are saved and locked until the result is confirmed.', 'التفاصيل محفوظة ومقفلة حتى تأكيد النتيجة.')}</p> : null}
    {!storageAvailable.current ? <p className="text-xs text-amber-800">{tr('Keep this page open until saving is confirmed. Browser storage is unavailable.', 'أبقِ الصفحة مفتوحة حتى تأكيد الحفظ. تخزين المتصفح غير متاح.')}</p> : null}
    <div className="grid gap-4 sm:grid-cols-2">{fields.filter(item => !item.advanced).map(field)}</div>
    {fields.some(item => item.advanced) ? <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">{tr('More details — optional', 'تفاصيل إضافية — اختيارية')}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{fields.filter(item => item.advanced).map(field)}</div></details> : null}
    {done && canAddAnother ? <button type="button" className="btn-secondary min-h-11" onClick={() => { setValues(defaults()); setDone(false); setSaved(null); setMessage(''); }}>{tr('Add another entry', 'إضافة سجل آخر')}</button>
      : stale ? <button type="button" className="btn-secondary min-h-11" onClick={() => router.refresh()}>{tr('Reload latest record before editing', 'تحميل أحدث نسخة قبل التعديل')}</button>
      : <button disabled={!ready || busy || blocked || done} className="btn-primary min-h-11 w-full sm:w-auto">{busy ? tr('Saving…', 'جارٍ الحفظ…') : done ? tr('Saved', 'تم الحفظ') : saved ? tr('Retry saved request', 'إعادة محاولة الطلب المحفوظ') : submitLabel}</button>}
  </form>;
}
