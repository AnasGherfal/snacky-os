import manifest from './company-proposal-kit.json';
import { emptyCompanyContent, type CompanyContent, type CompanyItem } from './company-hub';
export const proposalKit = manifest;
export type KitEntry = (typeof manifest)[number];
export const kitMarker = 'Snacky proposal kit import v1';
export const kitBundleLimit = 8_000_000;
export const kitUuid = (digest: string, part: 'file' | 'item') => {
  const s = part === 'file' ? digest.slice(0, 32) : digest.slice(32);
  return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;
};
export async function bytesDigest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function verifyKitFile(file: File): Promise<KitEntry> {
  const entry = proposalKit.find(x => x.name === file.name);
  if (!entry || file.size !== entry.size || await bytesDigest(await file.arrayBuffer()) !== entry.digest)
    throw Error('This is not an exact file from the prepared Snacky kit.');
  return entry;
}
export async function readKitFiles(files: File[]): Promise<File[]> {
  let selected = files;
  if (files.length === 1 && files[0].name.toLowerCase().endsWith('.json')) {
    if (files[0].size > kitBundleLimit) throw Error('Kit bundle is too large.');
    const input = JSON.parse(await files[0].text()) as { format?: unknown; files?: unknown };
    if (input.format !== 'snacky-proposal-kit/v1' || !Array.isArray(input.files) || input.files.length !== proposalKit.length)
      throw Error('Choose the complete prepared Snacky import bundle.');
    selected = input.files.map((row: { name?: unknown; base64?: unknown }) => {
      if (!row || typeof row.name !== 'string' || typeof row.base64 !== 'string') throw Error('Invalid file entry.');
      const spec = proposalKit.find(x => x.name === row.name);
      if (!spec || row.base64.length !== Math.ceil(spec.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.base64)) throw Error('Invalid file bytes.');
      const bytes = Uint8Array.from(atob(row.base64), c => c.charCodeAt(0));
      return new File([bytes], spec.name, { type: spec.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    });
  }
  if (!selected.length || selected.length > proposalKit.length || new Set(selected.map(x => x.name)).size !== selected.length)
    throw Error('Choose unique files from the prepared kit.');
  for (const file of selected) await verifyKitFile(file);
  return selected;
}
export function kitContent(entry: KitEntry, owner: string, review: string): CompanyContent {
  const management = entry.management_only;
  return {
    ...emptyCompanyContent('documents'),
    title_en: entry.title_en, title_ar: entry.title_ar,
    summary_en: management ? 'Previous/internal working material. Not the approved customer profile or final identity specification.' : 'Reusable Arabic material for preparing location proposals. Review edition/template, not an issued customer offer.',
    summary_ar: management ? 'مرجع سابق/داخلي للعمل، وليس الملف التعريفي المعتمد للعملاء أو مواصفة الهوية النهائية.' : 'مادة عربية قابلة لإعادة الاستخدام لإعداد عروض المواقع. نسخة مراجعة/قالب، وليست عرضاً صادراً لعميل.',
    body_en: `${kitMarker}\nSHA-256: ${entry.digest}\nUse the attached original file. Publication here makes it available internally only; it does not approve external sharing, prices or commercial terms. Complete placeholders and obtain approval before sending an issued copy. The original approved September profile record is not replaced by this import.`,
    body_ar: `${kitMarker}\nSHA-256: ${entry.digest}\nاستخدم الملف الأصلي المرفق. النشر هنا يتيح الاستخدام الداخلي فقط، ولا يعتمد المشاركة الخارجية أو الأسعار أو الشروط التجارية. أكمل الحقول واطلب الاعتماد قبل إرسال النسخة الصادرة. لا يستبدل هذا الاستيراد سجل الملف التعريفي المعتمد السابق.`,
    audience: management ? ['owner', 'admin'] : ['owner', 'admin', 'supervisor', 'crm'],
    owner_id: owner, review_date: review, file_id: kitUuid(entry.digest, 'file'),
    external_shareable: false, requires_ack: false, notify: false,
  };
}
export function untouchedKitDraft(record: CompanyItem, entry: KitEntry): boolean {
  const expected = kitContent(entry, record.data.owner_id, record.data.review_date);
  return record.current_version === 0 && !record.archived &&
    (Object.keys(expected) as (keyof CompanyContent)[]).every(k => JSON.stringify(record.data[k]) === JSON.stringify(expected[k]));
}
export type KitState = { user_id: string; directory: { id: string; name: string }[]; records: CompanyItem[]; files: { id: string; digest: string }[] };
