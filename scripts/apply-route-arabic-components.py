from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def patch(path,repls):
 p=ROOT/path;s=p.read_text(encoding='utf-8')
 for old,new,label in repls:
  c=s.count(old)
  if c!=1: raise RuntimeError(f'{label}: {c}')
  s=s.replace(old,new,1)
 p.write_text(s,encoding='utf-8')

patch('src/components/operator/RouteStopQuickActions.tsx',[
('  const { t } = useLanguage();\n','  const { t, locale } = useLanguage();\n  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);\n','helper'),
('{t("Quick product actions")}','{tr("Quick product actions", "إجراءات المنتجات السريعة")}','title'),
('{t("Manual sale")}','{tr("Manual sale", "بيع يدوي")}','manual'),
('{t("Damaged")}','{tr("Damaged", "تالف")}','damaged'),
('{t("Return")}','{tr("Return", "إرجاع من الجهاز")}','return'),
('{t("Tap once to open the correct searchable form. No need to scroll through every product.")}','{tr("Tap once to open the correct searchable form. No need to scroll through every product.", "اضغط مرة واحدة لفتح النموذج الصحيح القابل للبحث دون التمرير بين كل المنتجات.")}','note'),
])

patch('src/components/operator/CompressorSafetyProofCard.tsx',[
('  const { t } = useLanguage();\n','  const { t, locale } = useLanguage();\n  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);\n','helper'),
('{t("Required final safety check")}','{tr("Required final safety check", "فحص السلامة النهائي المطلوب")}','eyebrow'),
('{t("Compressor switched ON")}','{tr("Compressor switched ON", "تم تشغيل الضاغط")}','title'),
('{t("After filling, switch the compressor back on and take a close photo showing the ON switch or running indicator.")}','{tr("After filling, switch the compressor back on and take a close photo showing the ON switch or running indicator.", "بعد التعبئة شغّل الضاغط من جديد والتقط صورة قريبة توضح مفتاح التشغيل أو مؤشر عمل الجهاز.")}','instructions'),
('{ready ? t("Proof saved") : t("Required")}','{ready ? tr("Proof saved", "تم حفظ الإثبات") : tr("Required", "مطلوب")}','status'),
('{t("Checking saved proof...")}','{tr("Checking saved proof...", "جارٍ التحقق من الإثبات المحفوظ...")}','checking'),
('{t("Compressor proof setup is not installed yet. The existing route remains usable until the safety migration is applied.")}','{tr("Compressor proof setup is not installed yet. The existing route remains usable until the safety migration is applied.", "إعداد إثبات الضاغط غير مثبت بعد. ستظل الجولة الحالية قابلة للاستخدام إلى أن يتم تطبيق تحديث السلامة.")}','setup'),
('{t("Compressor ON proof is saved")}','{tr("Compressor ON proof is saved", "تم حفظ إثبات تشغيل الضاغط")}','saved'),
('{t("I switched the compressor ON and verified the machine is running.")}','{tr("I switched the compressor ON and verified the machine is running.", "قمت بتشغيل الضاغط وتأكدت أن الجهاز يعمل.")}','check'),
('{t("Photo of ON switch / running indicator")}','{tr("Photo of ON switch / running indicator", "صورة مفتاح التشغيل / مؤشر عمل الجهاز")}','photo'),
('{saving ? `${t("Saving")}...` : t("Save compressor proof")}','{saving ? `${tr("Saving", "جارٍ الحفظ")}...` : tr("Save compressor proof", "حفظ إثبات الضاغط")}','button'),
])
print('done')