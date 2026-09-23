'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useI18n } from '@/components/I18nProvider';
import {
  cashActionLabels, cashStateLabels, cashError, cashReceiptMatches, validateCashCommand,
  type CashAction, type CashBox, type CashCommand, type CashReceipt, type CashWorkspace,
} from '@/lib/cash-handover';
import styles from './CashHandlingWorkspace.module.css';
import { prepareCashPhoto } from '@/lib/cash-photo';

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function browserState(storageKey: string) {
  const selected = new URL(window.location.href).searchParams.get('id');
  try {
    const saved = sessionStorage.getItem(storageKey);
    const pending = saved ? validateCashCommand(JSON.parse(saved)) : null;
    return { selected: pending ? pending.collection_id : selected, pending, memoryOnly: false };
  } catch { return { selected, pending: null, memoryOnly: true }; }
}

export function CashHandlingWorkspace({ userId }: { userId: string }) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  const { locale } = useI18n();
  return hydrated ? <CashHandlingClient key={userId} userId={userId} />
    : <p role="status">{locale === 'ar' ? 'جارٍ تحميل سجلات النقد…' : 'Loading cash records…'}</p>;
}

function CashHandlingClient({ userId }: { userId: string }) {
  const storageKey = `snacky.cash-handover.pending.v1.${userId}`;
  const [initial] = useState(() => browserState(storageKey));
  const { locale } = useI18n(), ar = locale === 'ar';
  const text = (en: string, arabic: string) => ar ? arabic : en;
  const [view, setView] = useState<CashWorkspace | null>(null);
  const [status, setStatus] = useState('open'), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(initial.selected), [action, setAction] = useState<CashAction | null>(null);
  const [pending, setPending] = useState<CashCommand | null>(initial.pending), [receipt, setReceipt] = useState<CashReceipt | null>(null);
  const [error, setError] = useState(initial.pending ? 'uncertain' : ''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(initial.memoryOnly);
  const photo = useRef<File | null>(null), sequence = useRef(0), saving = useRef(false);
  const load = useCallback(() => {
    const seq = ++sequence.current;
    const params = new URLSearchParams({ status, offset: String(offset) }); if (selected) params.set('id', selected);
    return fetch(`/api/cash-handling?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !body.ok || body.data?.me !== userId) throw Error(body.code ?? 'unavailable');
        return body.data as CashWorkspace;
      })
      .then(data => { if (seq === sequence.current) setView(data); })
      .catch(e => { if (seq === sequence.current) { setView(null); setError(e instanceof Error && ['denied', 'invalid'].includes(e.message) ? e.message : 'unavailable'); } })
      .finally(() => { if (seq === sequence.current) setLoading(false); });
  }, [selected, status, offset, userId]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  function keep(command: CashCommand | null) {
    setPending(command);
    try { if (command) sessionStorage.setItem(storageKey, JSON.stringify(command)); else sessionStorage.removeItem(storageKey); }
    catch { setMemoryOnly(true); }
  }
  async function send(command: CashCommand, retry = false) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setReceipt(null);
    if (!retry) keep(command);
    try {
      let body: BodyInit, headers: HeadersInit = {};
      if (command.action === 'dropoff' && photo.current) {
        try { photo.current = await prepareCashPhoto(photo.current); } catch { setError('photo'); return; }
        const form = new FormData(); form.set('command', JSON.stringify(command)); form.set('photo', photo.current); body = form;
      } else { body = JSON.stringify(command); headers = { 'Content-Type': 'application/json' }; }
      const response = await fetch('/api/cash-handling', { method: 'POST', headers, body, signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      if (!response.ok || !cashReceiptMatches(command, result)) {
        const code = typeof result.code === 'string' ? result.code : 'uncertain';
        setError(code);
        // Known database rejections are rolled back. Transport errors and photo
        // retries keep the exact immutable command, including its request UUID.
        if (!result.retryable && ['denied', 'invalid', 'conflict'].includes(code)) { keep(null); setAction(null); await load(); }
        return;
      }
      keep(null); setReceipt(result); setAction(null); photo.current = null; await load();
    } catch { setError('uncertain'); }
    finally { saving.current = false; setBusy(false); }
  }
  function management(kind: 'enable' | 'counter', payload: CashCommand['payload']) {
    const explanation = kind === 'enable'
      ? text(payload.enabled ? 'Enable new cash handovers? Existing routes and legacy cash records are unchanged.' : 'Pause new handovers? Boxes already enrolled can still be completed.', payload.enabled ? 'تفعيل تسليم النقد الجديد؟ لن تتغير المسارات أو سجلات النقد السابقة.' : 'إيقاف التسليمات الجديدة؟ يمكن إكمال العلب المسجلة بالفعل.')
      : text(payload.enabled ? 'Grant counting permission only? This does not grant Finance access.' : 'Remove counting permission? Picked-up boxes remain recorded and need an owner takeover.', payload.enabled ? 'منح صلاحية العد فقط؟ لا تمنح هذه الصلاحية الوصول إلى المالية.' : 'إلغاء صلاحية العد؟ تبقى العلب المستلمة مسجلة وتحتاج إلى استلام عهدتها من المالك.');
    if (!window.confirm(explanation)) return;
    void send(validateCashCommand({ request_id: crypto.randomUUID(), collection_id: null, action: kind, revision: 0, payload }));
  }
  function open(id: string | null) {
    if (pending || busy) return;
    setLoading(true); setSelected(id); setAction(null); setError(''); setReceipt(null);
    window.history.replaceState(null, '', id ? `/cash-handling?id=${encodeURIComponent(id)}` : '/cash-handling');
  }
  function submit(event: FormEvent<HTMLFormElement>, box: CashBox) {
    event.preventDefault(); if (!action || pending || busy) return;
    const form = new FormData(event.currentTarget), get = (key: string) => String(form.get(key) ?? '').trim();
    const payload: CashCommand['payload'] = action === 'assign' ? { assigned_to: get('assigned_to') }
      : action === 'dropoff' ? { assigned_to: get('assigned_to'), storage_location: get('storage_location'), seal_condition: get('seal_condition'), notes: get('notes') }
      : action === 'count' ? { amount: get('amount'), cash_location: get('cash_location') }
      : { confirm_bag_id: get('confirm_bag_id'), seal_condition: get('seal_condition'), notes: get('notes') };
    try {
      const command = validateCashCommand({ request_id: crypto.randomUUID(), collection_id: box.id, action, revision: box.revision, payload });
      void send(command);
    } catch { setError('invalid'); }
  }
  function date(value: string | null) {
    return value ? new Intl.DateTimeFormat(ar ? 'ar-LY' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Tripoli' }).format(new Date(value)) : '—';
  }
  const locked = busy || Boolean(pending), box = selected ? view?.rows.find(r => r.id === selected) : null;
  const label = (a: CashAction) => cashActionLabels[a][ar ? 1 : 0];
  return <section className={styles.workspace} dir={ar ? 'rtl' : 'ltr'} data-testid="cash-handling">
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{text('SNACKY · TEAM OPERATIONS', 'سناكي · عمليات الفريق')}</p>
        <h1>{text('Cash handling', 'تسليم وعد النقد')}</h1>
        <p>{text('One box. One history. A named person at every handover.', 'كل علبة لها سجل واحد، ومسؤول واضح في كل مرحلة.')}</p></div>
      <div className={styles.buttons}>{view?.can_remove ? <Link className={styles.secondary} href="/cash-collections/new">{text('Record machine collection', 'تسجيل سحب من آلة')}</Link> : null}
        <button className={styles.secondary} disabled={busy} onClick={() => { setError(''); setLoading(true); void load(); }}>{text('Refresh', 'تحديث')}</button></div>
    </header>
    <p className={styles.privacy}>{text('Cash handling does not grant access to company balances or the Finance dashboard.', 'تسليم وعد النقد لا يمنح الوصول إلى أرصدة الشركة أو لوحة المالية.')}</p>
    {error ? <div role="alert" className={styles.error}>{cashError(error, ar)}</div> : null}
    {memoryOnly ? <p className={styles.notice}>{text('This browser could not preserve the retry locally. Keep this page open until saving is confirmed.', 'تعذر حفظ طلب الإعادة في المتصفح. لا تغلق الصفحة حتى يتأكد الحفظ.')}</p> : null}
    {pending ? <section className={styles.pending} aria-label={text('Unconfirmed action', 'إجراء غير مؤكد')}>
      <h2>{text('Check the saved action before doing anything else', 'تحقق من الطلب المحفوظ قبل أي إجراء آخر')}</h2>
      <p>{label(pending.action)}{pending.action === 'count' ? <> · <bdi>{String(pending.payload.amount)} LYD</bdi></> : null}</p>
      <p className={styles.hint}>{text('Retry recovers the original receipt or submits the same action once. It does not create a new cash entry.', 'إعادة المحاولة تسترجع الإيصال الأصلي أو تسجل الإجراء نفسه مرة واحدة. لا تنشئ قيداً نقدياً جديداً.')}</p>
      {pending.action === 'dropoff' ? <label>{text('Reattach the same storage photo only if requested', 'أعد إرفاق صورة المخزن نفسها عند طلبها')}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => { photo.current = e.target.files?.[0] ?? null; }} /></label> : null}
      <button className={styles.primary} disabled={busy} onClick={() => void send(pending, true)}>{busy ? text('Checking…', 'جارٍ التحقق…') : text('Retry the saved request', 'إعادة الطلب المحفوظ')}</button>
    </section> : null}
    {receipt ? <div role="status" className={styles.success}>
      <strong>{receipt.action === 'count' ? text('Count saved and posted to Snacky Finance', 'تم حفظ العد وتسجيله في مالية سناكي') : text('Action recorded', 'تم تسجيل الإجراء')}</strong>
      {receipt.amount ? <div className={styles.amount}><bdi>{receipt.amount} LYD</bdi></div> : null}
      <p className={styles.hint}>{text('Receipt', 'الإيصال')}: <bdi>{receipt.request_id}</bdi></p>
      {receipt.action === 'count' ? <p>{text('VMS comparison can follow later. The cash still remains with the recorded custodian or at the location entered.', 'يمكن مطابقة VMS لاحقاً. يبقى النقد بعهدة المسؤول أو في الموقع المسجل.')}</p> : null}
    </div> : null}
    {loading ? <p role="status" className={styles.hint}>{text('Loading cash records…', 'جارٍ تحميل سجلات النقد…')}</p> : null}
    {!view && !loading ? <button className={styles.secondary} onClick={() => void load()}>{text('Reload cash handling', 'إعادة تحميل تسليم النقد')}</button> : null}
    {view ? <>
      {!view.enabled ? <div className={styles.notice}>{text('New handovers are paused. Existing enrolled boxes can still be completed. The original cash workflow remains available.', 'التسليمات الجديدة متوقفة. يمكن إكمال العلب المسجلة بالفعل. مسار النقد السابق ما زال متاحاً.')}</div> : null}
      {view.owner && !selected ? <details className={styles.settings}><summary>{text('Owner controls · counting access and pilot', 'إعدادات المالك · صلاحية العد والتشغيل')}</summary>
        <p>{text('Give an employee counting permission here, not the Finance role. Permissions already granted through other roles are not removed.', 'امنح الموظف صلاحية العد هنا، وليس دور المالية. الصلاحيات الممنوحة عبر أدوار أخرى لا تُلغى تلقائياً.')}</p>
        <button className={styles.secondary} disabled={locked} onClick={() => management('enable', { enabled: !view.enabled })}>{view.enabled ? text('Pause new handovers', 'إيقاف التسليمات الجديدة') : text('Enable new handovers', 'تفعيل التسليمات الجديدة')}</button>
        <div className={styles.people}>{view.people.map(person => <div key={person.id} className={styles.person}><div><strong>{person.name}</strong><p className={styles.hint}>{person.owner ? text('Owner / admin', 'مالك / مدير') : person.can_count ? text('Counting enabled', 'صلاحية العد مفعلة') : text('Counting not enabled', 'صلاحية العد غير مفعلة')}</p>{person.finance_access ? <p className={styles.warning}>{text('Existing role already has Finance access.', 'الدور الحالي يمنح الوصول إلى المالية بالفعل.')}</p> : null}</div>{!person.owner ? <button className={styles.secondary} disabled={locked} onClick={() => management('counter', { user_id: person.id, enabled: !person.enabled })}>{person.enabled ? text('Remove counting', 'إلغاء صلاحية العد') : text('Allow counting', 'السماح بالعد')}</button> : null}</div>)}</div>
      </details> : null}
      {!selected ? <>
        <nav className={styles.tabs} aria-label={text('Cash queue', 'قائمة النقد')}>{[['open', 'Needs action', 'تحتاج إجراء'], ['counted', 'Counted', 'تم العد'], ['all', 'History', 'السجل']].map(([value, en, arabic]) =>
          <button key={value} disabled={locked} aria-current={status === value ? 'page' : undefined} onClick={() => { setLoading(true); setStatus(value); setOffset(0); setError(''); }}>{text(en, arabic)}</button>)}</nav>
        <div className={styles.queueHeader}><h2>{view.owner ? text('Team cash boxes', 'علب نقد الفريق') : text('My cash boxes', 'علب النقد الخاصة بي')}</h2><span>{view.total} {text('records', 'سجلاً')}</span></div>
        {!view.rows.length && !loading ? <div className={styles.empty}><h3>{text('No boxes in this view', 'لا توجد علب في هذا العرض')}</h3><p>{text('Collected boxes and boxes assigned to you will appear here. No money is added by assigning or moving a box.', 'تظهر هنا العلب التي جمعتها أو أُسندت إليك. الإسناد أو نقل العلبة لا يضيف أي مبلغ.')}</p></div> : null}
        <div className={styles.grid}>{view.rows.map(row => <article key={row.id} className={styles.card}>
          <div className={styles.cardTop}><span className={styles.badge}>{(cashStateLabels[row.state] ?? [row.state, row.state])[ar ? 1 : 0]}</span>{row.seal_exception ? <span className={styles.warning}>{text('Seal exception', 'ملاحظة على الختم')}</span> : null}</div>
          <h3>{row.machines.map(m => m.location || m.name).join(' · ') || text('Cash collection', 'تحصيل نقد')}</h3>
          <p className={styles.boxId}>{text('Box / seal', 'العلبة / الختم')} <bdi>{row.bag}</bdi></p>
          <dl className={styles.facts}><div><dt>{text('Collector', 'المحصّل')}</dt><dd>{row.collector ?? '—'}</dd></div><div><dt>{text('Coordinator', 'المسؤول')}</dt><dd>{row.assignee ?? text('Not assigned', 'غير مسند')}</dd></div>
            <div><dt>{text('Collected', 'وقت السحب')}</dt><dd>{date(row.collected_at)}</dd></div><div><dt>{text('Storage', 'المخزن')}</dt><dd>{row.storage ?? '—'}</dd></div></dl>
          {row.amount !== null ? <p className={styles.amount}><bdi>{row.amount} LYD</bdi></p> : null}
          {row.assignee && !row.assignee_active && row.state !== 'counted' ? <p className={styles.warning}>{text('Coordinator inactive. Owner action required.', 'المسؤول غير مفعل. يلزم إجراء من المالك.')}</p> : null}
          <button className={styles.secondary} disabled={locked} onClick={() => open(row.id)}>{text('Open box', 'فتح العلبة')}</button>
        </article>)}</div>
        <nav className={styles.buttons} aria-label={text('Queue pages', 'صفحات القائمة')}>
          {offset > 0 ? <button disabled={locked} className={styles.secondary} onClick={() => setOffset(Math.max(0, offset - 25))}>{text('Previous', 'السابق')}</button> : null}
          {offset + 25 < view.total ? <button disabled={locked} className={styles.secondary} onClick={() => setOffset(offset + 25)}>{text('Next', 'التالي')}</button> : null}
        </nav>
      </> : <>
        <button className={styles.secondary} disabled={locked} onClick={() => open(null)}>{text('Back to cash boxes', 'العودة إلى علب النقد')}</button>
        {box ? <article className={styles.detail}>
          <span className={styles.badge}>{(cashStateLabels[box.state] ?? [box.state, box.state])[ar ? 1 : 0]}</span>
          <h2>{box.machines.map(m => m.location || m.name).join(' · ') || text('Cash collection', 'تحصيل نقد')}</h2>
          <p className={styles.boxId}>{text('Box / seal', 'العلبة / الختم')}: <bdi>{box.bag}</bdi></p>
          <p className={styles.hint}>{text('Collection reference', 'مرجع التحصيل')}: <bdi>{box.id}</bdi></p>
          {box.amount !== null ? <p className={styles.amount}><bdi>{box.amount} LYD</bdi></p> : null}
          <dl className={styles.facts}><div><dt>{text('Collector', 'المحصّل')}</dt><dd>{box.collector ?? '—'}</dd></div><div><dt>{text('Coordinator', 'المسؤول')}</dt><dd>{box.assignee ?? '—'}</dd></div>
            <div><dt>{text('Current custodian', 'المسؤول عن العهدة')}</dt><dd>{box.custodian ?? box.collector ?? '—'}</dd></div><div><dt>{text('Recorded cash location', 'موقع النقد المسجل')}</dt><dd>{box.cash_location ?? box.storage ?? '—'}</dd></div></dl>
          {box.state === 'dropped' ? <p className={styles.notice}>{text('The collector recorded a storage drop-off. The coordinator has not acknowledged pickup yet.', 'سجّل المحصّل وضع العلبة في المخزن. لم يؤكد المسؤول استلامها بعد.')}</p> : null}
          {box.seal_exception ? <p className={styles.error}>{text('Seal exception recorded. Count the actual money; owner review is still required.', 'تم تسجيل ملاحظة على الختم. يُعد المبلغ الفعلي، وتبقى مراجعة المالك مطلوبة.')}</p> : null}
          {box.evidence_url ? <a className={styles.secondary} href={box.evidence_url} target="_blank" rel="noreferrer noopener">{text('View storage photo', 'عرض صورة المخزن')}</a> : box.deposited_at ? <p className={styles.hint}>{text('Refresh to load the private storage photo.', 'حدّث الصفحة لتحميل صورة المخزن الخاصة.')}</p> : null}
          {!action ? <div className={styles.buttons}>{box.actions.map(a => <button className={a === 'count' || a === 'pickup' || a === 'dropoff' ? styles.primary : styles.secondary} key={a} disabled={locked} onClick={() => { setAction(a); setError(''); }}>{label(a)}</button>)}</div> : null}
          {action && box.actions.includes(action) && !pending ? <form className={styles.form} onSubmit={e => submit(e, box)} key={`${box.id}-${action}-${box.revision}`}>
            <h3>{label(action)}</h3>
            <fieldset disabled={locked}>
              {['assign', 'dropoff'].includes(action) ? <label>{text('Coordinator', 'المسؤول عن العد')}
                {action === 'dropoff' && box.assigned_to ? <><input type="hidden" name="assigned_to" value={box.assigned_to} /><span>{box.assignee}</span></> : <select name="assigned_to" defaultValue={box.assigned_to ?? ''} required><option value="">{text('Choose an authorized person', 'اختر شخصاً مخولاً')}</option>{view.counters.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select>}</label> : null}
              {action === 'dropoff' ? <>
                <p className={styles.hint}>{text('Record this only after leaving the sealed box in the designated secure place. This is not a receipt by another employee.', 'سجّل ذلك بعد وضع العلبة المختومة في المكان الآمن المحدد. هذا ليس تأكيد استلام من موظف آخر.')}</p>
                <label>{text('Exact storage / safe location', 'موقع المخزن / الخزنة بالتحديد')}<input name="storage_location" required minLength={2} maxLength={180} /></label>
                <label>{text('Photo of the box in storage', 'صورة العلبة في المخزن')}<input type="file" accept="image/jpeg,image/png,image/webp" required onChange={e => { photo.current = e.target.files?.[0] ?? null; }} /></label>
              </> : null}
              {['pickup', 'direct_pickup', 'takeover'].includes(action) ? <label>{text('Enter the reference on the physical box / seal', 'اكتب الرقم الموجود على العلبة / الختم')}<input name="confirm_bag_id" autoComplete="off" required maxLength={120} /></label> : null}
              {['dropoff', 'pickup', 'direct_pickup', 'takeover'].includes(action) ? <>
                <label>{text('Seal condition', 'حالة الختم')}<select name="seal_condition" defaultValue="intact"><option value="intact">{text('Intact', 'سليم')}</option><option value="broken">{text('Broken', 'مفتوح / مكسور')}</option><option value="mismatch">{text('Reference mismatch', 'الرقم غير مطابق')}</option></select></label>
                <label>{text('Notes · required for an exception or takeover', 'ملاحظات · مطلوبة عند وجود ملاحظة أو نقل العهدة')}<textarea name="notes" maxLength={1000} rows={3} required={action === 'takeover'} /></label>
              </> : null}
              {action === 'count' ? <>
                <label>{text('Total counted · LYD', 'إجمالي النقد المعدود · دينار')}<input name="amount" inputMode="decimal" autoComplete="off" dir="ltr" pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" required placeholder="0.00" /></label>
                <label>{text('Where is the counted cash now?', 'أين يوجد النقد بعد العد؟')}<input name="cash_location" required minLength={2} maxLength={180} placeholder={text('For example: storage safe, shelf A', 'مثال: خزنة المخزن، الرف أ')} /></label>
                <p className={styles.hint}>{text('Enter the physical total only. Zero is valid only for a genuinely empty box. Do not subtract shopping or expenses. VMS checking can follow later.', 'أدخل المبلغ الفعلي فقط. الصفر صحيح فقط إذا كانت العلبة فارغة فعلاً. لا تخصم المشتريات أو المصروفات. يمكن مطابقة VMS لاحقاً.')}</p>
              </> : null}
              <label className={styles.checkbox}><input type="checkbox" required />{text('I confirm this describes what I physically did and checked.', 'أؤكد أن هذا يطابق ما قمت به وتحققت منه فعلياً.')}</label>
              <div className={styles.buttons}><button className={styles.primary} type="submit">{action === 'count' ? text('Confirm count & record once', 'تأكيد العد والتسجيل مرة واحدة') : text('Confirm action', 'تأكيد الإجراء')}</button><button type="button" className={styles.secondary} onClick={() => setAction(null)}>{text('Cancel', 'إلغاء')}</button></div>
            </fieldset>
          </form> : null}
          <section className={styles.timeline}><h3>{text('Custody history', 'سجل العهدة')}</h3><ol>
            <li><strong>{text('Collected from machine', 'تم السحب من الآلة')}</strong><p>{box.collector} · {date(box.collected_at)}</p></li>
            {!box.deposited_at && box.storage && box.state !== 'collected' && box.state !== 'assigned' ? <li><strong>{text('Earlier storage record', 'سجل المخزن السابق')}</strong><p>{box.storage}</p></li> : null}
            {box.events.map(e => <li key={e.id}><strong>{label(e.action)}</strong><p>{e.by} · {date(e.at)}</p>{e.detail.location ? <p>{e.detail.location}</p> : null}{e.detail.notes ? <p>{e.detail.notes}</p> : null}</li>)}
          </ol></section>
          {view.owner ? <Link className={styles.secondary} href={`/cash-collections/${box.id}`}>{text('Open owner reconciliation', 'فتح مطابقة النقد للمالك')}</Link> : null}
        </article> : null}
      </>}
    </> : null}
  </section>;
}
