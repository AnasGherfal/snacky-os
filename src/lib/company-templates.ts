import {
  emptyCompanyContent,
  type CompanyContent,
  type CompanyRole,
} from './company-hub';
/** Proposed starter wording, not published policies or employee contracts. No real salaries, contacts or agreements. */
type Template = {
  key: string;
  en: string;
  ar: string;
  section: CompanyContent['section'];
  roles: CompanyRole[];
  path: string;
  body_en: string;
  body_ar: string;
};
const staff: CompanyRole[] = [
  'owner',
  'admin',
  'supervisor',
  'crm',
  'operator',
  'warehouse',
  'purchasing',
  'finance',
];
export const companyTemplates: Template[] = [
  {
    key: 'welcome',
    en: 'Welcome to Snacky — start here',
    ar: 'مرحباً بك في سناكي — ابدأ هنا',
    section: 'start',
    roles: staff,
    path: '',
    body_en:
      'Purpose\nSnacky provides vending services. Snacky OS is where responsibilities, work outcomes and follow-ups are recorded.\n\nFirst steps\nReview the responsibilities for your role. Open your normal workspace. Confirm your first assignments with your manager. Read the published procedures relevant to your work.\n\nWorking rule\nLog important calls, WhatsApp conversations and visits on the related record. Keep an owner and next action/date, or a waiting reason and review date. Urgent calls are still appropriate; record their outcome afterwards.\n\nDocuments\nUse the approved library. Keep customer evidence, signed agreements and payment receipts on their original business records. Never publish private staff documents in a general guide.',
    body_ar:
      'الهدف\nتقدم سناكي خدمات البيع الذاتي. نظام سناكي هو مكان توثيق المسؤوليات ونتائج العمل والمتابعات.\n\nالخطوات الأولى\nراجع مسؤوليات دورك. افتح مساحة عملك المعتادة. اتفق مع المسؤول على المهام الأولى. اقرأ الإجراءات المنشورة المتعلقة بعملك.\n\nقاعدة العمل\nسجّل نتائج المكالمات ومحادثات واتساب والزيارات المهمة في السجل المرتبط بها. حدّد المسؤول والخطوة القادمة وموعدها، أو سبب الانتظار وموعد المراجعة. اتصل عند الضرورة العاجلة ثم سجّل النتيجة.\n\nالوثائق\nاستخدم المكتبة المعتمدة. احتفظ بأدلة العملاء والاتفاقيات الموقعة وإيصالات الدفع في سجلاتها الأصلية. لا تنشر وثائق الموظفين الخاصة في دليل عام.',
  },
  {
    key: 'relations-role',
    en: 'Customer Relations & Business Development — responsibilities',
    ar: 'علاقات العملاء وتطوير الأعمال — المسؤوليات',
    section: 'people',
    roles: ['crm', 'owner', 'admin', 'supervisor'],
    path: '/my-work',
    body_en:
      'Responsible for\nResearch and visit potential locations; maintain contacts; record leads and follow-ups; prepare proposals for approval. Receive customer issues, coordinate field actions, and communicate the outcome. Maintain relationships with existing locations and follow up administrative obligations.\n\nApproval boundaries\nManagement approves commercial terms and changes to rent. Authorized Finance/management confirms payments. Uploading proof or completing a follow-up is not a payment confirmation. Do not commit to refunds, discounts or expenses outside an explicitly recorded authority.\n\nDaily and weekly rhythm\nReview My Work. Record each visit/call outcome and next action. Review waiting and overdue items. At the agreed weekly review, discuss lead progress, unresolved issues, obligations and decisions needed.\n\nFirst week\nManager provides initial leads, current location contacts and first assignments. Practise using clearly marked practice records, never real payments or inventory. Review the published visit, issue and rent procedures.',
    body_ar:
      'المسؤوليات\nالبحث عن مواقع محتملة وزيارتها، تحديث جهات الاتصال، تسجيل الجهات والمتابعات، وإعداد العروض لاعتمادها. استقبال مشاكل العملاء وتنسيق الإجراءات الميدانية وإبلاغ العميل بالنتيجة. متابعة العلاقة بالمواقع الحالية والالتزامات الإدارية.\n\nحدود الصلاحية\nتعتمد الإدارة الشروط التجارية وتغييرات الإيجار. يؤكد الدفع المسؤول المالي أو الإداري المخوّل. رفع الإثبات أو إنهاء المتابعة لا يُعد تأكيداً للدفع. لا تلتزم باسترداد أو تخفيض أو مصروف خارج صلاحية موثقة صراحةً.\n\nيومياً وأسبوعياً\nراجع عملي اليوم. سجّل نتيجة كل زيارة أو مكالمة والخطوة القادمة. راجع المنتظر والمتأخر. ناقش تقدم الجهات والمشاكل المفتوحة والالتزامات والقرارات المطلوبة في المراجعة الأسبوعية المتفق عليها.\n\nالأسبوع الأول\nيوفر المسؤول الجهات الأولية وجهات اتصال المواقع والمهام الأولى. تدرب بسجلات واضحة أنها تدريبية، وليس بمدفوعات أو مخزون حقيقي. راجع إجراءات الزيارة والمشاكل والإيجار المنشورة.',
  },
  {
    key: 'visits',
    en: 'Visit a potential location',
    ar: 'زيارة موقع محتمل',
    section: 'guides',
    roles: ['crm', 'owner', 'admin', 'supervisor'],
    path: '/locations-pipeline',
    body_en:
      'When\nBefore contacting or visiting a potential location.\n\nDo\nSearch for an existing lead first. Review its contacts and previous activity. Use the approved presentation. Ask about footfall, site access, decision-maker, placement, electricity and product restrictions. Do not promise unapproved commercial terms.\n\nRecord\nRecord the contact, visit outcome, useful photos with permission, proposed next step and follow-up date on the lead. Attach the actual proposal sent, not just a link to a changing template.\n\nEscalate\nSend commercial decisions and unusual commitments to management with the facts and decision needed.',
    body_ar:
      'متى\nقبل التواصل مع موقع محتمل أو زيارته.\n\nماذا تفعل\nابحث أولاً عن سجل موجود للجهة. راجع جهات الاتصال والنشاط السابق. استخدم العرض المعتمد. اسأل عن الحركة والوصول وصاحب القرار ومكان الماكينة والكهرباء وقيود المنتجات. لا تعد بشروط تجارية غير معتمدة.\n\nماذا تسجل\nسجّل جهة الاتصال ونتيجة الزيارة والصور المفيدة بإذن صاحبها والخطوة القادمة وموعد المتابعة. أرفق نسخة العرض الذي أُرسل فعلاً، وليس رابط قالب يتغير.\n\nمتى تصعّد\nارفع القرارات التجارية والالتزامات غير المعتادة للإدارة مع المعلومات والقرار المطلوب.',
  },
  {
    key: 'issues',
    en: 'Handle a customer issue',
    ar: 'التعامل مع مشكلة عميل',
    section: 'guides',
    roles: ['crm', 'owner', 'admin', 'supervisor', 'operator'],
    path: '/issues',
    body_en:
      'When\nA customer reports a vending problem.\n\nDo\nRecord the issue even if the machine or photo is not yet known. Link the correct location/machine when identified. Assign the required field action through the existing workflow.\n\nRecord\nKeep customer communication and evidence on the issue. The operator records the field result on the assigned action.\n\nFinish\nA completed field action does not automatically resolve the customer issue. The relations employee reviews the outcome, communicates with the customer and records resolution. Keep unresolved work visible.\n\nEscalate\nCall the responsible manager for urgent safety or service concerns. Refunds follow the explicitly approved authority; this guide creates no new refund limit.',
    body_ar:
      'متى\nعندما يبلغ عميل عن مشكلة في الشراء.\n\nماذا تفعل\nسجّل المشكلة حتى لو لم تُعرف الماكينة أو تتوفر صورة بعد. اربط الموقع والماكينة عند تحديدهما. أسند الإجراء الميداني المطلوب عبر المسار الحالي.\n\nماذا تسجل\nاحتفظ بالتواصل مع العميل والإثباتات داخل المشكلة. يسجّل المشغّل نتيجة الإجراء الميداني في مهمته.\n\nالإنهاء\nإنهاء الإجراء الميداني لا يحل مشكلة العميل تلقائياً. يراجع موظف العلاقات النتيجة ويتواصل مع العميل ويوثق الحل. تبقى الحالات غير المحلولة ظاهرة.\n\nالتصعيد\nاتصل بالمسؤول عند وجود أمر عاجل يتعلق بالسلامة أو الخدمة. تتبع المبالغ المستردة الصلاحية المعتمدة صراحةً؛ هذا الدليل لا يحدد سقفاً جديداً للاسترداد.',
  },
  {
    key: 'rent',
    en: 'Follow up location rent and obligations',
    ar: 'متابعة إيجار الموقع والتزاماته',
    section: 'guides',
    roles: ['crm', 'owner', 'admin', 'finance', 'supervisor'],
    path: '/relationships/obligations',
    body_en:
      'When\nA location obligation is due, awaiting evidence or awaiting a decision.\n\nDo\nReview the existing location agreement, obligation and authorized payment record. Confirm the next step with the responsible person.\n\nRecord\nAttach proof to the original obligation. Record the contact outcome and next review date. Reporting a payment and Finance verification are different states.\n\nApproval\nOnly authorized management/Finance confirms a matching payment through the existing workflow. Do not create duplicate expenses, independently mark an obligation financially paid or change agreed rent.',
    body_ar:
      'متى\nعند اقتراب التزام موقع أو انتظار إثبات أو قرار.\n\nماذا تفعل\nراجع اتفاقية الموقع والالتزام وسجل الدفع المعتمد. اتفق على الخطوة القادمة مع المسؤول.\n\nماذا تسجل\nأرفق الإثبات بالالتزام الأصلي. سجّل نتيجة التواصل وموعد المراجعة القادمة. الإبلاغ عن الدفع والتحقق المالي منه حالتان مختلفتان.\n\nالاعتماد\nيؤكد المسؤول المالي أو الإداري المخوّل الدفع المطابق عبر الإجراء الحالي. لا تنشئ مصروفاً مكرراً ولا تؤكد الدفع المالي بشكل مستقل ولا تغير الإيجار المتفق عليه.',
  },
  {
    key: 'operator',
    en: 'Operator — responsibilities and handoff',
    ar: 'المشغّل — المسؤوليات وتسليم النتائج',
    section: 'people',
    roles: ['operator', 'owner', 'admin', 'supervisor'],
    path: '/operator/routes',
    body_en:
      'Use your assigned route and pickup workflows. Record stock, quantities, cash and required evidence in the existing screens; this guide does not replace their checks.\n\nFor an assigned customer action, record what you found, what you did and the result. Escalate unresolved problems and record any urgent call outcome. Do not close the customer complaint on behalf of the relations employee.\n\nAn unread guide or unavailable library must never prevent urgent operational work.',
    body_ar:
      'استخدم إجراءات المسارات والاستلام المسندة إليك. سجّل المخزون والكميات والنقد والإثباتات المطلوبة في الشاشات الحالية؛ هذا الدليل لا يستبدل فحوصاتها.\n\nعند إسناد إجراء يخص عميلاً، سجّل ما وجدته وما فعلته والنتيجة. صعّد المشاكل غير المحلولة ووثّق نتيجة أي مكالمة عاجلة. لا تغلق شكوى العميل نيابة عن موظف العلاقات.\n\nيجب ألا تمنع قراءة دليل معلقة أو مكتبة غير متاحة تنفيذ العمل التشغيلي العاجل.',
  },
  {
    key: 'brand-guidelines',
    en: 'Snacky brand guidelines',
    ar: 'دليل هوية سناكي',
    section: 'documents',
    roles: staff,
    path: '',
    body_en:
      'Library category: Brand\n\nAttach the current approved Snacky brand-guidelines file. Use this entry as the single reference for logo use, colors, typography, spacing, backgrounds and approved brand applications.\n\nBefore publication\nConfirm that the attached file matches the current Snacky identity. Do not publish draft logo experiments or obsolete artwork. Mark external sharing only if management approves sharing the file outside Snacky.',
    body_ar:
      'تصنيف المكتبة: الهوية\n\nأرفق ملف دليل هوية سناكي المعتمد حالياً. يكون هذا السجل المرجع الواحد لاستخدام الشعار والألوان والخطوط والمسافات والخلفيات وتطبيقات الهوية المعتمدة.\n\nقبل النشر\nتأكد أن الملف المرفق يطابق هوية سناكي الحالية. لا تنشر تجارب شعارات أو ملفات قديمة. فعّل المشاركة الخارجية فقط إذا اعتمدت الإدارة مشاركة الملف خارج سناكي.',
  },
  {
    key: 'logo-pack',
    en: 'Snacky logo pack',
    ar: 'حزمة شعارات سناكي',
    section: 'documents',
    roles: staff,
    path: '',
    body_en:
      'Library category: Brand\n\nAttach the approved logo asset for this entry and name the exact variant in the title, for example primary, white or transparent. Create separate entries when the files have different approved uses.\n\nUse only the current published version. Do not copy logos from old proposals, chats or screenshots.',
    body_ar:
      'تصنيف المكتبة: الهوية\n\nأرفق ملف الشعار المعتمد لهذا السجل واذكر النسخة بوضوح في العنوان مثل الأساسي أو الأبيض أو الشفاف. أنشئ سجلاً منفصلاً إذا كان لكل ملف استخدام معتمد مختلف.\n\nاستخدم النسخة المنشورة الحالية فقط. لا تنسخ الشعارات من عروض قديمة أو محادثات أو لقطات شاشة.',
  },
  {
    key: 'company-profile',
    en: 'Snacky company profile',
    ar: 'الملف التعريفي بسناكي',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '/locations-pipeline',
    body_en:
      'Library category: Company\n\nAttach the current approved company profile used with prospective locations and partners. This entry is the reusable master reference; the exact file actually sent to a lead should still be attached to that lead or business record when required.\n\nReview contact details, current services, location examples and branding before publication.',
    body_ar:
      'تصنيف المكتبة: الشركة\n\nأرفق الملف التعريفي الحالي المعتمد للاستخدام مع المواقع المحتملة والشركاء. هذا السجل هو المرجع القابل لإعادة الاستخدام؛ أما النسخة التي أُرسلت فعلياً لجهة معينة فتبقى مرفقة بسجل تلك الجهة عند الحاجة.\n\nراجع بيانات التواصل والخدمات الحالية وأمثلة المواقع والهوية قبل النشر.',
  },
  {
    key: 'brochure',
    en: 'Snacky brochure — approved print version',
    ar: 'بروشور سناكي — النسخة المعتمدة للطباعة',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '/locations-pipeline',
    body_en:
      'Library category: Marketing\n\nAttach the current print-ready Snacky brochure. The approved file should use sharp real/vector text and separate high-resolution logos and QR assets rather than baked-in low-quality image text.\n\nOnly mark external sharing when this exact version is approved for customers and locations.',
    body_ar:
      'تصنيف المكتبة: التسويق\n\nأرفق بروشور سناكي الحالي الجاهز للطباعة. يجب أن تستخدم النسخة المعتمدة نصوصاً حقيقية/متجهية واضحة وشعارات ورموز QR عالية الدقة كعناصر مستقلة، لا نصوصاً ضعيفة مدمجة داخل صورة.\n\nفعّل المشاركة الخارجية فقط عندما تكون هذه النسخة نفسها معتمدة للإرسال للعملاء والمواقع.',
  },
  {
    key: 'machine-catalog',
    en: 'Snacky machine catalog',
    ar: 'كتالوج ماكينات سناكي',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '/locations-pipeline',
    body_en:
      'Library category: Marketing\n\nAttach the current approved machine catalog. Keep customer-facing machine options, visuals and feature descriptions current. Do not expose supplier costs, private sourcing details or obsolete pricing in a file intended for external sharing.',
    body_ar:
      'تصنيف المكتبة: التسويق\n\nأرفق كتالوج الماكينات الحالي المعتمد. حافظ على خيارات الماكينات والصور ووصف المزايا الموجهة للعملاء محدثة. لا تعرض تكاليف المورد أو تفاصيل التوريد الخاصة أو أسعاراً قديمة داخل ملف مخصص للمشاركة الخارجية.',
  },
  {
    key: 'proposal-template',
    en: 'General location proposal template',
    ar: 'قالب عرض عام للمواقع',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '/locations-pipeline',
    body_en:
      'Library category: Templates\n\nAttach the approved reusable proposal master. Commercial terms must be reviewed for the specific location before sending. Save the exact final proposal sent to a customer on that customer or lead record; do not rely only on this changing master.',
    body_ar:
      'تصنيف المكتبة: القوالب\n\nأرفق أصل العرض العام المعتمد والقابل لإعادة الاستخدام. يجب مراجعة الشروط التجارية لكل موقع قبل الإرسال. احفظ النسخة النهائية التي أُرسلت فعلياً للعميل في سجل العميل أو الجهة؛ لا تعتمد فقط على هذا الأصل المتغير.',
  },
  {
    key: 'agreement-template',
    en: 'Location agreement template',
    ar: 'قالب اتفاقية موقع',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '/relationships',
    body_en:
      'Library category: Templates\n\nAttach the approved blank location-agreement template. This general library entry is for the reusable master only. Signed agreements belong on the specific location record and should not be stored as general company-library material.',
    body_ar:
      'تصنيف المكتبة: القوالب\n\nأرفق قالب اتفاقية الموقع الفارغ المعتمد. هذا السجل العام مخصص للأصل القابل لإعادة الاستخدام فقط. الاتفاقيات الموقعة تُحفظ في سجل الموقع المحدد ولا توضع كمادة عامة في مكتبة الشركة.',
  },
  {
    key: 'receipt-delivery-templates',
    en: 'Receipt and delivery form templates',
    ar: 'قوالب الإيصالات ونماذج التسليم',
    section: 'documents',
    roles: ['owner', 'admin', 'finance', 'supervisor'],
    path: '/finance',
    body_en:
      'Library category: Templates\n\nAttach the approved blank receipt or delivery-form master and identify the exact document type in the title. Issued receipts and completed delivery forms belong to the relevant transaction or business record.',
    body_ar:
      'تصنيف المكتبة: القوالب\n\nأرفق الأصل الفارغ المعتمد للإيصال أو نموذج التسليم وحدد نوع المستند بوضوح في العنوان. الإيصالات الصادرة ونماذج التسليم المكتملة تُحفظ في سجل العملية أو المعاملة ذات الصلة.',
  },
  {
    key: 'machine-technical',
    en: 'Machine manuals and technical references',
    ar: 'أدلة الماكينات والمراجع الفنية',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'operator', 'warehouse'],
    path: '/operator/routes',
    body_en:
      'Library category: Technical\n\nAttach one approved machine manual or technical reference per entry and name the machine or component clearly. Keep troubleshooting references separate from operational records; actual incidents and repairs remain on their issue or machine records.',
    body_ar:
      'تصنيف المكتبة: الفني\n\nأرفق دليلاً واحداً معتمداً للماكينة أو مرجعاً فنياً في كل سجل واذكر الماكينة أو القطعة بوضوح. افصل مراجع استكشاف الأعطال عن السجلات التشغيلية؛ الأعطال والإصلاحات الفعلية تبقى في سجلات المشكلة أو الماكينة.',
  },
  {
    key: 'marketing-assets',
    en: 'Approved marketing assets',
    ar: 'مواد التسويق المعتمدة',
    section: 'documents',
    roles: ['owner', 'admin', 'supervisor', 'crm'],
    path: '',
    body_en:
      'Library category: Marketing\n\nUse this type of entry for approved reusable social assets, banners, posters, instruction stickers and other customer-facing brand material. Use a clear title for each asset instead of uploading a mixed unnamed bundle.',
    body_ar:
      'تصنيف المكتبة: التسويق\n\nاستخدم هذا النوع من السجلات للمواد الاجتماعية واللافتات والملصقات وملصقات التعليمات وغيرها من مواد الهوية الموجهة للعملاء بعد اعتمادها. استخدم عنواناً واضحاً لكل مادة بدلاً من رفع حزمة مختلطة غير مسماة.',
  },
  {
    key: 'materials',
    en: 'Use approved documents and brand assets',
    ar: 'استخدام الوثائق ومواد الهوية المعتمدة',
    section: 'guides',
    roles: staff,
    path: '',
    body_en:
      'Find reusable presentations, templates and logos in Documents & Brand. Use clear approved versions rather than old chat attachments. Only materials explicitly approved for external sharing may be sent outside Snacky.\n\nEditable masters can remain in company-controlled Drive. Check access at the source. Create a separate final copy for each offer or agreement and attach that copy to its business record. Never overwrite a previously sent proposal or signed document.\n\nReport outdated or missing materials to the content owner. Company content is not a place for salaries, employee contracts or other restricted personal records.',
    body_ar:
      'ابحث عن العروض والقوالب والشعارات القابلة لإعادة الاستخدام في الوثائق والهوية. استخدم النسخ المعتمدة والواضحة بدلاً من مرفقات المحادثات القديمة. لا ترسل خارج سناكي إلا المواد المعتمدة صراحةً للمشاركة الخارجية.\n\nيمكن إبقاء الملفات الأصلية القابلة للتعديل في مساحة Drive تسيطر عليها الشركة. تحقق من صلاحية الوصول في المصدر. أنشئ نسخة نهائية مستقلة لكل عرض أو اتفاقية وأرفقها بسجلها. لا تستبدل عرضاً سبق إرساله أو مستنداً موقعاً.\n\nأبلغ مسؤول المحتوى عن المواد القديمة أو الناقصة. محتوى الشركة العام ليس مكاناً للمرتبات أو عقود الموظفين أو البيانات الشخصية المقيدة.',
  },
];
export function companyTemplate(key: string): CompanyContent | undefined {
  const t = companyTemplates.find((x) => x.key === key);
  if (!t) return undefined;
  return {
    ...emptyCompanyContent(t.section),
    title_en: t.en,
    title_ar: t.ar,
    summary_en: 'Starter draft — review and adapt before publication.',
    summary_ar: 'مسودة أولية — راجعها وعدّلها قبل النشر.',
    body_en: t.body_en,
    body_ar: t.body_ar,
    audience: t.roles,
    work_path: t.path,
  };
}
