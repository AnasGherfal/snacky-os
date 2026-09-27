import Link from 'next/link';
import { requireCurrentProfileForPath } from '@/lib/auth';
import { getServerI18n } from '@/lib/i18n/server';
import { PageHeader } from '@/components/ui';
import { CompanyPrint } from '@/components/CompanyEditor';
import { CompanyReferenceNotice } from '@/components/CompanyReferenceNotice';
export const dynamic = 'force-dynamic';

export default async function SnackyCompanyProfilePage() {
  await requireCurrentProfileForPath('/company/profile');
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return <div className="company-hub company-reference-page mx-auto max-w-4xl space-y-6" dir={ar ? 'rtl' : 'ltr'}>
    <PageHeader title={tr('Snacky service overview', 'نبذة عن خدمة سناكي')} subtitle={tr('Internal background for presenting the service.', 'مرجع داخلي للتعريف بالخدمة.')} action={<CompanyPrint ar={ar}/>} />
    <CompanyReferenceNotice ar={ar}/>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Snacky in 30 seconds', 'سناكي في 30 ثانية')}</h2><p className="text-base leading-8">{tr('Snacky operates vending machines for snacks and drinks in suitable high-traffic locations. We handle products, refilling, cleaning and operational follow-up, giving visitors and staff a convenient service without requiring the host to run it.', 'تدير سناكي ماكينات بيع ذاتي للوجبات الخفيفة والمشروبات في المواقع المناسبة ذات الحركة المرتفعة. نتولى المنتجات والتعبئة والنظافة والمتابعة التشغيلية، لتقديم خدمة سهلة للزوار والموظفين دون أن يضطر الموقع إلى تشغيلها بنفسه.')}</p></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Start with the value to the location', 'ابدأ بالقيمة التي يحصل عليها الموقع')}</h2><p className="leading-8">{tr('Explain who will use the machine, where it will be visible and accessible, and how Snacky will manage the service. Present Snacky primarily as an operator—not as a machine sale. Do not lead with an unapproved rent, commission or installation promise.', 'وضّح من سيستخدم الماكينة، وأين ستكون واضحة وسهلة الوصول، وكيف ستتولى سناكي إدارة الخدمة. قدّم سناكي أساساً كمشغّل للخدمة، لا كعملية بيع ماكينة. لا تبدأ بوعد غير معتمد بشأن الإيجار أو النسبة أو موعد التركيب.')}</p></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Qualify before committing', 'قيّم الموقع قبل الالتزام')}</h2><p className="leading-8">{tr('Collect the place name, location, decision-maker, daily activity and opening hours. Check placement, power, access for refilling and product restrictions. Record the visit, outcome and next follow-up in the existing lead. Commercial terms and installation timing need management confirmation.', 'اجمع اسم الجهة وموقعها وصاحب القرار والحركة اليومية وساعات العمل. راجع مكان الماكينة والكهرباء وإمكانية الوصول للتعبئة وقيود المنتجات. سجّل الزيارة ونتيجتها والمتابعة القادمة في سجل الجهة الموجود. تحتاج الشروط التجارية وموعد التركيب إلى تأكيد الإدارة.')}</p></section>
    <section className="surface-card space-y-3"><h2 className="text-xl font-semibold">{tr('Send the real approved profile', 'أرسل الملف التعريفي المعتمد الفعلي')}</h2><p className="leading-8">{tr('Use the published profile attachment from the library. Check its date, contact details and sharing status, then keep the exact sent copy on the lead record. This reference deliberately does not reproduce changing location counts, prices or contact information.', 'استخدم مرفق الملف التعريفي المنشور في المكتبة. راجع تاريخه وبيانات التواصل وصلاحية المشاركة، ثم احفظ النسخة المرسلة فعلياً في سجل الجهة. لا يكرر هذا المرجع أعداد المواقع أو الأسعار أو بيانات التواصل المتغيرة.')}</p><Link className="btn-primary inline-flex" href="/company/documents">{tr('Open the document library', 'فتح مكتبة الوثائق')}</Link></section>
  </div>;
}
