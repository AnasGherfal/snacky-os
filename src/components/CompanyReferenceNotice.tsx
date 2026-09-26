import Link from 'next/link';
/** Stays visible in print: a reference page is not a controlled, published file. */
export function CompanyReferenceNotice({ ar }: { ar: boolean }) {
  return <section role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-7 text-amber-950">
    <strong>{ar ? 'مرجع داخلي — ليس مستنداً منشوراً معتمداً' : 'Internal reference — not a published, approved document'}</strong>
    <p>{ar ? 'للمشاركة الخارجية، افتح مكتبة الوثائق ونزّل النسخة المنشورة التي تحمل إذناً بالمشاركة. طباعة هذه الصفحة لا تجعلها الملف التعريفي المعتمد أو دليلاً رسمياً للهوية.' : 'For external use, download the published file carrying an external-sharing approval in the document library. Printing this page does not make it the approved company profile or an issued brand manual.'}</p>
    <Link href="/company/documents" className="font-semibold underline">{ar ? 'فتح مكتبة الوثائق' : 'Open the document library'}</Link>
  </section>;
}
