import Link from 'next/link';
import {requireCurrentProfileForPath} from '@/lib/auth';
import {getServerI18n} from '@/lib/i18n/server';
import {PageHeader} from '@/components/ui';
import {CompanyPrint} from '@/components/CompanyEditor';

export const dynamic='force-dynamic';

const palette=[
 {name:'Snacky Orange',hex:'#f5820b',useEn:'Primary actions and brand accent',useAr:'الإجراءات الرئيسية ولمسة الهوية'},
 {name:'Snacky Green',hex:'#3f6f3f',useEn:'Secondary accent and selected states',useAr:'لون مساعد والحالات المحددة'},
 {name:'Neutral',hex:'#f8fafc',useEn:'Backgrounds and quiet surfaces',useAr:'الخلفيات والمساحات الهادئة'},
 {name:'Ink',hex:'#0f172a',useEn:'Primary text',useAr:'النص الأساسي'},
];

export default async function SnackyBrandGuidePage(){
 await requireCurrentProfileForPath('/company/brand-guide');
 const {locale}=await getServerI18n();
 const ar=locale==='ar';
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 return <div className="company-resource mx-auto max-w-5xl space-y-6" dir={ar?'rtl':'ltr'}>
  <style>{`@media print {
    .app-shell > aside, .app-shell > div > header, .print\\:hidden { display:none !important; }
    .app-shell, .app-shell > div, .app-shell main, .company-resource { display:block !important; height:auto !important; max-height:none !important; overflow:visible !important; }
    .company-resource { max-width:none !important; margin:0 !important; }
    @page { margin: 1.4cm; }
  }`}</style>
  <PageHeader
   title={tr('Snacky Quick Brand Guide','دليل سناكي السريع للهوية')}
   subtitle={tr('Internal reference for using the current Snacky identity consistently.','مرجع داخلي لاستخدام هوية سناكي الحالية بشكل موحّد.')}
   action={<div className="flex flex-wrap gap-2 print:hidden"><CompanyPrint ar={ar}/><Link className="btn-secondary" href="/company/documents">{tr('Back to Documents & Brand','العودة إلى المستندات والهوية')}</Link></div>}
  />

  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
   <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[.9fr_1.1fr] lg:items-center">
    <div className="flex justify-center rounded-2xl bg-[#fff8f2] p-8">
     {/* eslint-disable-next-line @next/next/no-img-element */}
     <img src="/brand/snacky-logo.png" alt="Snacky" className="max-h-44 w-full object-contain"/>
    </div>
    <div>
     <p className="text-sm font-semibold text-[#3f6f3f]">{tr('SOURCE OF TRUTH','المرجع الأساسي')}</p>
     <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{tr('Use the current published Snacky logo.','استخدم شعار سناكي الحالي المعتمد.')}</h2>
     <p className="mt-3 text-sm leading-7 text-slate-600">{tr('Do not redraw the logo, copy it from screenshots, add effects, stretch it, recolor it, or use old mascot experiments. When a new official logo version is published in Snacky OS, that version replaces older copies.','لا تعِد رسم الشعار، ولا تنسخه من لقطات الشاشة، ولا تضف تأثيرات أو تمدده أو تغيّر ألوانه أو تستخدم تجارب قديمة للشخصية. عند نشر نسخة رسمية جديدة في نظام سناكي تصبح هي المرجع بدلاً من النسخ السابقة.')}</p>
    </div>
   </div>
  </section>

  <section className="surface-card">
   <h2 className="text-xl font-semibold">{tr('Working color palette','لوحة الألوان المستخدمة')}</h2>
   <p className="mt-2 text-sm leading-7 text-slate-600">{tr('These are the restrained working tokens used by Snacky OS and current company materials. White and neutral surfaces should remain dominant; orange and green are accents.','هذه هي الألوان العملية المستخدمة حالياً في نظام سناكي ومواد الشركة. تبقى المساحات البيضاء والمحايدة هي الغالبة، ويُستخدم البرتقالي والأخضر كلونين مساعدَين.')}</p>
   <div className="mt-5 grid gap-3 sm:grid-cols-2">
    {palette.map(item=><div key={item.hex} className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
      <span className="h-14 w-14 shrink-0 rounded-xl border border-black/10" style={{background:item.hex}} aria-label={item.hex}/>
      <div><strong className="block">{item.name}</strong><code className="text-sm text-slate-600">{item.hex}</code><p className="mt-1 text-xs text-slate-500">{ar?item.useAr:item.useEn}</p></div>
    </div>)}
   </div>
  </section>

  <section className="grid gap-4 md:grid-cols-2">
   <article className="surface-card">
    <h2 className="text-xl font-semibold">{tr('Do','افعل')}</h2>
    <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
     <li>• {tr('Use real, selectable Arabic and English text in brochures, proposals and signs.','استخدم نصاً عربياً وإنجليزياً حقيقياً وقابلاً للتحديد في البروشورات والعروض واللافتات.')}</li>
     <li>• {tr('Keep Arabic layouts genuinely RTL, including alignment, numbering and spacing.','اجعل تصميم العربية من اليمين إلى اليسار فعلياً، بما في ذلك المحاذاة والترقيم والمسافات.')}</li>
     <li>• {tr('Place logos and QR codes as separate high-resolution assets.','ضع الشعارات ورموز QR كعناصر مستقلة عالية الدقة.')}</li>
     <li>• {tr('Use clear filenames and current versions for anything shared externally.','استخدم أسماء ملفات واضحة والنسخة الحالية لأي مادة تُرسل خارج الشركة.')}</li>
    </ul>
   </article>
   <article className="surface-card">
    <h2 className="text-xl font-semibold">{tr("Don't",'لا تفعل')}</h2>
    <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
     <li>• {tr('Do not use AI-generated image text as final Arabic artwork.','لا تستخدم نصاً مولداً داخل صورة بالذكاء الاصطناعي كنسخة عربية نهائية.')}</li>
     <li>• {tr('Do not use an old logo from WhatsApp, screenshots or previous proposals.','لا تستخدم شعاراً قديماً من واتساب أو لقطات الشاشة أو عروض سابقة.')}</li>
     <li>• {tr('Do not mix unrelated colors or decorative styles into official materials.','لا تخلط ألواناً أو أساليب زخرفية غير مرتبطة بالهوية داخل المواد الرسمية.')}</li>
     <li>• {tr('Do not overwrite a proposal or agreement that was already sent; keep the issued copy on its business record.','لا تستبدل عرضاً أو اتفاقية سبق إرسالها؛ احتفظ بالنسخة الصادرة في سجلها التجاري.')}</li>
    </ul>
   </article>
  </section>

  <section className="surface-card">
   <h2 className="text-xl font-semibold">{tr('File naming','تسمية الملفات')}</h2>
   <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
    <div className="rounded-xl bg-slate-50 p-4"><strong>{tr('Logo example','مثال شعار')}</strong><p className="mt-1 font-mono text-xs">Snacky-Logo-Primary.png</p></div>
    <div className="rounded-xl bg-slate-50 p-4"><strong>{tr('Document example','مثال مستند')}</strong><p className="mt-1 font-mono text-xs">Snacky-Company-Profile-2026-09.pdf</p></div>
   </div>
  </section>

  <p className="text-xs leading-6 text-slate-500">{tr('This is a quick internal usage guide. The published logo in Snacky OS remains the authoritative artwork.','هذا دليل استخدام داخلي سريع. يبقى الشعار المنشور في نظام سناكي هو الملف الرسمي المعتمد للهوية.')}</p>
 </div>;
}
