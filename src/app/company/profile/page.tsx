import Link from 'next/link';
import {requireCurrentProfileForPath} from '@/lib/auth';
import {getServerI18n} from '@/lib/i18n/server';
import {PageHeader} from '@/components/ui';

export const dynamic='force-dynamic';

const currentLocationsAr=['HT Mall / HT Land','الدبلوماسي مول','جامعة التحدي','جامعة طرابلس الأهلية','مستشفى المواصفات','مصحة الاستقلال'];
const currentLocationsEn=['HT Mall / HT Land','Diplomacy Mall','Attahadi University','Tripoli Private University','Al-Muwasafat Hospital','Al-Istiqlal Clinic'];

export default async function SnackyCompanyProfilePage(){
 await requireCurrentProfileForPath('/company/profile');
 const {locale}=await getServerI18n();
 const ar=locale==='ar';
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const locations=ar?currentLocationsAr:currentLocationsEn;
 return <div className="mx-auto max-w-5xl space-y-6" dir={ar?'rtl':'ltr'}>
  <PageHeader
   title={tr('Snacky Company Profile','الملف التعريفي بسناكي')}
   subtitle={tr('Approved internal reference for presenting Snacky to prospective locations.','المرجع الداخلي المعتمد لتقديم سناكي للجهات المحتملة.')}
   action={<Link className="btn-secondary" href="/company/documents">{tr('Back to Documents & Brand','العودة إلى المستندات والهوية')}</Link>}
  />
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
   <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.15fr_.85fr] lg:items-center">
    <div>
     <p className="text-sm font-semibold text-[var(--snacky-primary)]">{tr('SELF-SERVICE VENDING','خدمة بيع ذاتي')}</p>
     <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{tr('A closer service. An easier day.','خدمة أقرب. ويوم أسهل.')}</h2>
     <p className="mt-4 max-w-2xl text-base leading-8 text-slate-600">{tr('Snacky operates self-service vending machines for snacks and drinks in high-traffic locations. We handle setup, products, refilling, follow-up and day-to-day operation so the host location receives a simple, managed service.','تدير سناكي ماكينات بيع ذاتي للوجبات الخفيفة والمشروبات في الأماكن ذات الحركة المرتفعة. نتولى التجهيز والمنتجات والتعبئة والمتابعة والتشغيل اليومي لتصل للموقع خدمة بسيطة ومدارة بالكامل.')}</p>
    </div>
    <div className="flex justify-center rounded-2xl bg-[#fff8f2] p-8">
     {/* eslint-disable-next-line @next/next/no-img-element */}
     <img src="/brand/snacky-logo.png" alt="Snacky" className="max-h-48 w-full object-contain"/>
    </div>
   </div>
  </section>

  <section className="grid gap-4 md:grid-cols-2">
   <article className="surface-card">
    <h2 className="text-xl font-semibold">{tr('What Snacky handles','ما الذي تتولاه سناكي؟')}</h2>
    <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
     <li>• {tr('Site assessment and suitable machine placement.','تقييم الموقع واختيار مكان مناسب للماكينة.')}</li>
     <li>• {tr('Product selection, stocking and regular refilling.','اختيار المنتجات وتوفيرها والتعبئة الدورية.')}</li>
     <li>• {tr('Routine follow-up, cleaning and operational support.','المتابعة الدورية والنظافة والدعم التشغيلي.')}</li>
     <li>• {tr('Customer support and issue follow-up when needed.','خدمة العملاء ومتابعة أي مشكلة عند الحاجة.')}</li>
    </ul>
   </article>
   <article className="surface-card">
    <h2 className="text-xl font-semibold">{tr('Where the service fits','أين تناسب الخدمة؟')}</h2>
    <p className="mt-4 text-sm leading-7 text-slate-700">{tr('Snacky focuses on locations where people spend time and benefit from quick access to snacks and drinks: universities, hospitals and clinics, schools, malls, offices and similar high-traffic environments.','تركز سناكي على الأماكن التي يقضي فيها الناس وقتاً ويستفيدون من وصول سريع للوجبات الخفيفة والمشروبات: الجامعات، المستشفيات والمصحات، المدارس، المولات، المكاتب والأماكن المشابهة ذات الحركة المرتفعة.')}</p>
   </article>
  </section>

  <section className="surface-card">
   <h2 className="text-xl font-semibold">{tr('Selected current locations','نماذج من مواقع سناكي الحالية')}</h2>
   <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {locations.map(location=><div key={location} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium">{location}</div>)}
   </div>
  </section>

  <section className="grid gap-4 md:grid-cols-3">
   {[['1',tr('Tell us about the location','عرّفنا بالموقع')],['2',tr('Snacky reviews suitability','تقيّم سناكي ملاءمة الموقع')],['3',tr('Agree the setup and next step','نتفق على التجهيز والخطوة التالية')]].map(([n,label])=><article key={n} className="surface-card"><span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--snacky-primary)] text-sm font-semibold text-white">{n}</span><p className="mt-3 font-semibold">{label}</p></article>)}
  </section>

  <section className="rounded-2xl bg-slate-950 p-6 text-white sm:p-8">
   <p className="text-sm font-semibold text-orange-300">{tr('CONTACT','تواصل معنا')}</p>
   <h2 className="mt-2 text-2xl font-semibold">{tr('Interested in Snacky at your location?','مهتم بوجود سناكي في موقعك؟')}</h2>
   <div className="mt-5 flex flex-wrap gap-3 text-sm">
    <a className="rounded-xl bg-white px-4 py-3 font-semibold text-slate-950" href="tel:+218917669886">091 766 9886</a>
    <a className="rounded-xl border border-white/30 px-4 py-3 font-semibold" href="https://snacky.ly" target="_blank" rel="noopener noreferrer">snacky.ly</a>
   </div>
  </section>

  <p className="text-xs leading-6 text-slate-500">{tr('Internal approved reference. Commercial terms, rent, discounts and installation commitments require the normal Snacky approval process.','مرجع داخلي معتمد. الشروط التجارية والإيجار والخصومات والالتزام بالتركيب تخضع لآلية الاعتماد المعتادة في سناكي.')}</p>
 </div>;
}
