/** Cash handling commands are intentionally separate from Finance permissions. */
export const cashHandlingRoles = ['owner', 'admin', 'supervisor', 'operator', 'warehouse', 'purchasing', 'finance'] as const;
export const cashUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const cashAmount = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;
export type CashAction = 'enable' | 'counter' | 'assign' | 'dropoff' | 'pickup' | 'direct_pickup' | 'takeover' | 'count';
export type CashCommand = { request_id: string; collection_id: string | null; action: CashAction; revision: number; payload: Record<string, string | boolean> };
export type CashReceipt = { ok: true; request_id: string; collection_id: string | null; action: CashAction; revision: number; amount?: string; finance_posted?: boolean };
export type CashPerson = { id: string; name: string; enabled?: boolean; can_count?: boolean; owner?: boolean; finance_access?: boolean };
export type CashBox = {
  id: string; bag: string; revision: number; state: string; collector: string | null; collected_at: string;
  assigned_to: string | null; assignee: string | null; assignee_active: boolean; storage: string | null;
  deposited_at: string | null; depositor: string | null; picked_up_at: string | null; custodian: string | null;
  cash_location: string | null; counted_at: string | null; counter: string | null; amount: string | null;
  seal_exception: boolean; evidence_path?: string | null; evidence_url?: string | null;
  machines: { name: string; location: string | null }[]; actions: CashAction[];
  events: { id: string; action: CashAction; at: string; by: string; detail: { location?: string; seal?: string; notes?: string } }[];
};
export type CashWorkspace = { me: string; owner: boolean; can_count: boolean; enabled: boolean; can_remove: boolean; people: CashPerson[]; counters: CashPerson[]; rows: CashBox[]; total: number; offset: number };
const actionFields: Record<CashAction, string[]> = {
  enable: ['enabled'], counter: ['user_id', 'enabled'], assign: ['assigned_to'],
  dropoff: ['assigned_to', 'storage_location', 'seal_condition', 'notes'],
  pickup: ['confirm_bag_id', 'seal_condition', 'notes'], direct_pickup: ['confirm_bag_id', 'seal_condition', 'notes'],
  takeover: ['confirm_bag_id', 'seal_condition', 'notes'], count: ['amount', 'cash_location'],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) throw new Error('invalid');
}
function uuid(value: unknown) { if (typeof value !== 'string' || !cashUuid.test(value)) throw new Error('invalid'); }
function text(value: unknown, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new Error('invalid');
}
export function validateCashCommand(value: unknown): CashCommand {
  const c = object(value); exactKeys(c, ['request_id', 'collection_id', 'action', 'revision', 'payload']);
  uuid(c.request_id);
  if (typeof c.revision !== 'number' || !Number.isSafeInteger(c.revision) || c.revision < 0 || c.revision > 999999999) throw new Error('invalid');
  if (typeof c.action !== 'string' || !Object.hasOwn(actionFields, c.action)) throw new Error('invalid');
  const action = c.action as CashAction, p = object(c.payload); exactKeys(p, actionFields[action]);
  if (['enable', 'counter'].includes(action)) {
    if (c.collection_id !== null || c.revision !== 0 || typeof p.enabled !== 'boolean') throw new Error('invalid');
  } else uuid(c.collection_id);
  for (const [key, value] of Object.entries(p)) if (key !== 'enabled' && typeof value !== 'string') throw new Error('invalid');
  if ('assigned_to' in p) uuid(p.assigned_to);
  if ('user_id' in p) uuid(p.user_id);
  if ('seal_condition' in p && !['intact', 'broken', 'mismatch'].includes(String(p.seal_condition))) throw new Error('invalid');
  if ('notes' in p) text(p.notes, p.seal_condition !== 'intact' || action === 'takeover' ? 3 : 0, 1000);
  if ('storage_location' in p) text(p.storage_location, 2, 180);
  if ('confirm_bag_id' in p) text(p.confirm_bag_id, 1, 120);
  if (action === 'count') {
    if (typeof p.amount !== 'string' || !cashAmount.test(p.amount)) throw new Error('invalid');
    text(p.cash_location, 2, 180);
  }
  if (JSON.stringify(c).length > 10000) throw new Error('invalid');
  return c as CashCommand;
}
/** Compare decimal strings as integer cents, without floating point money. */
export function cashCents(value: string): number {
  if (!cashAmount.test(value)) throw new Error('invalid');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function cashReceiptMatches(command: CashCommand, value: unknown): value is CashReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<CashReceipt>;
  if (r.ok !== true || r.request_id !== command.request_id || r.collection_id !== command.collection_id || r.action !== command.action
    || r.revision !== (command.collection_id ? command.revision + 1 : 0)) return false;
  if (command.action !== 'count') return true;
  try { return r.finance_posted === true && typeof r.amount === 'string' && cashCents(r.amount) === cashCents(String(command.payload.amount)); }
  catch { return false; }
}
export function cashSameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site';
}
export const cashActionLabels: Record<CashAction, [string, string]> = {
  enable: ['Pilot setting', 'إعداد التشغيل'], counter: ['Counting permission', 'صلاحية عد النقد'],
  assign: ['Assign coordinator', 'إسناد المسؤول'], dropoff: ['Left in storage', 'وضعتها في المخزن'],
  pickup: ['Pick up this box', 'استلام العلبة'], direct_pickup: ['I will count my collected box', 'سأعد العلبة التي جمعتها'],
  takeover: ['Take over custody', 'استلام العهدة من المسؤول'], count: ['Count and record', 'عد النقد وتسجيله'],
};
export const cashStateLabels: Record<string, [string, string]> = {
  collected: ['With collector', 'مع المحصّل'], assigned: ['Coordinator assigned', 'تم إسناد المسؤول'],
  dropped: ['In storage · pickup pending', 'في المخزن · بانتظار الاستلام'], stored: ['Stored · assignment / pickup pending', 'في المخزن · بانتظار الإسناد أو الاستلام'],
  picked_up: ['With coordinator · count pending', 'مع المسؤول · بانتظار العد'], counted: ['Counted', 'تم العد'], voided: ['Voided', 'ملغاة'],
};
export function cashError(code: string, ar: boolean) {
  const messages: Record<string, [string, string]> = {
    denied: ['Access denied. Your active account, assignment or counting permission may have changed.', 'لا تتوفر الصلاحية. قد يكون حسابك أو الإسناد أو صلاحية العد قد تغيّر.'],
    conflict: ['This box changed on another device. Reload before submitting a new action.', 'تغيرت العلبة على جهاز آخر. أعد تحميلها قبل تسجيل إجراء جديد.'],
    invalid: ['Review the box reference, amount, location and seal notes. The action may no longer be available.', 'راجع رقم العلبة والمبلغ والموقع وملاحظات الختم. قد يكون الإجراء غير متاح الآن.'],
    photo: ['Choose a JPG, PNG or WEBP photo under 10 MB. No handover was recorded.', 'اختر صورة JPG أو PNG أو WEBP بحجم أقل من 10 ميغابايت. لم يتم تسجيل التسليم.'],
    unavailable: ['Cash handling could not be loaded. This is not an empty queue. Reload after the connection or database update is complete.', 'تعذر تحميل تسليم النقد. هذا لا يعني أن القائمة فارغة. أعد التحميل بعد استعادة الاتصال أو تحديث قاعدة البيانات.'],
    uncertain: ['Save not confirmed. Do not create a second entry. Retry this same saved request.', 'لم يتأكد الحفظ. لا تنشئ تسجيلاً آخر. أعد محاولة الطلب المحفوظ نفسه.'],
  };
  return (messages[code] ?? messages.invalid)[ar ? 1 : 0];
}
