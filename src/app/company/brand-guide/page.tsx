import Link from 'next/link';
import { requireCurrentProfileForPath } from '@/lib/auth';
import { getServerI18n } from '@/lib/i18n/server';
import { PageHeader } from '@/components/ui';
import { CompanyPrint } from '@/components/CompanyEditor';
import { CompanyReferenceNotice } from '@/components/CompanyReferenceNotice';
export const dynamic = 'force-dynamic';

export default async function SnackyBrandGuidePage() {
  await requireCurrentProfileForPath('/company/brand-guide');
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return <div className="company-hub company-reference-page mx-auto max-w-4xl space-y-6" dir={ar ? 'rtl' : 'ltr'}>
    <PageHeader title={tr('Brand usage notes', 'ملاحظات استخدام الهوية')} subtitle={tr('Practical guidance—not a replacement for approved artwork.', 'إرشادات عملية، وليست بديلاً عن ملفات الهوية المعتمدة.')} action={<CompanyPrint ar={ar}/>} />
    <CompanyReferenceNotice ar={ar}/>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('One authoritative logo file', 'ملف رسمي واحد للشعار')}</h2><p className="leading-8">{tr('Download the current published logo from Documents & Brand. Do not retype “Snacky / سناكي” as a substitute, redraw the mark, extract it from a screenshot, or assume the website image is the current master. Use only the variants actually supplied and approved.', 'نزّل الشعار المنشور حالياً من مكتبة الوثائق والهوية. لا تُعِد كتابة «Snacky / سناكي» كبديل للشعار، ولا تعِد رسمه أو تستخرجه من لقطة شاشة، ولا تفترض أن صورة الموقع هي الأصل الحالي. استخدم فقط النسخ المتوفرة والمعتمدة فعلياً.')}</p><Link className="btn-primary inline-flex" href="/company/documents">{tr('Get the published artwork', 'فتح ملفات الهوية المنشورة')}</Link></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Application colors are not a print specification', 'ألوان التطبيق ليست مواصفة للطباعة')}</h2><p className="leading-8">{tr('Snacky OS currently uses orange #f5820b and green #3f6f3f as working interface tokens. They were sampled for the application. Do not present them as approved CMYK/Pantone values or a complete corporate palette. A printer should use the approved master artwork and confirm the output with management.', 'يستخدم نظام سناكي حالياً البرتقالي #f5820b والأخضر #3f6f3f كألوان عملية للواجهة تم أخذها للتطبيق. لا تعرضها كقيم CMYK أو Pantone معتمدة أو كلوحة ألوان مؤسسية كاملة. يجب أن تعتمد المطبعة على الملف الأصلي المعتمد وأن تؤكد النتيجة مع الإدارة.')}</p></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Prepare a usable production file', 'جهّز ملفاً صالحاً للإنتاج')}</h2><p className="leading-8">{tr('Keep Arabic as real, editable text with right-to-left layout and English left-to-right. Check numbered steps, phone numbers and line breaks. Place the supplied logo and a tested QR code as separate elements. Use real machine photos with permission; do not illustrate a feature or location that is not supported by the source.', 'اجعل العربية نصاً حقيقياً قابلاً للتعديل بتخطيط من اليمين إلى اليسار، والإنجليزية من اليسار إلى اليمين. راجع الخطوات المرقمة وأرقام الهواتف وفواصل الأسطر. ضع الشعار المزوّد ورمز QR المختبَر كعناصر مستقلة. استخدم صور ماكينات حقيقية بإذن؛ لا تعرض ميزة أو موقعاً لا يدعمه المصدر.')}</p></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Check before sending or printing', 'راجع قبل الإرسال أو الطباعة')}</h2><p className="leading-8">{tr('Confirm the owner, published version, sharing permission, contact details and destination of every QR code. Inspect the exported PDF—not just the editable source—for clipping and missing text. Keep the exact issued copy with its business record. A changing editable-master link is not an immutable issued document.', 'تأكد من المسؤول والنسخة المنشورة وإذن المشاركة وبيانات التواصل ووجهة كل رمز QR. افحص ملف PDF المصدّر نفسه، لا الأصل القابل للتعديل فقط، للتأكد من عدم قص النصوص أو فقدها. احتفظ بالنسخة الصادرة فعلياً في سجلها. رابط الأصل القابل للتعديل والمتغير ليس وثيقة صادرة ثابتة.')}</p></section>
    <p className="text-sm leading-7 text-slate-600">{tr('The published logo in Snacky OS remains the authoritative artwork.', 'يبقى الشعار المنشور في نظام سناكي هو ملف الهوية الرسمي.')}</p>
  </div>;
}
