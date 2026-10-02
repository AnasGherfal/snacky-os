import Link from 'next/link';
import { getCurrentProfile } from '@/lib/auth';
import { isOwnerAdminRole } from '@/lib/authz';
import { companyHubEnabled } from '@/lib/company-hub';
import { getServerI18n } from '@/lib/i18n/server';
export async function CompanyKitImportAction() {
  const profile = await getCurrentProfile();
  if (!companyHubEnabled || !profile || profile.active_status !== 'active' || !isOwnerAdminRole(profile)) return null;
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  return <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4" dir={ar ? 'rtl' : 'ltr'}>
    <p className="text-sm text-emerald-950">{ar ? 'أضف ملفات PDF والأصول القابلة للتعديل دفعة واحدة، دون إنشاء سجلات فارغة.' : 'Add the prepared PDFs and editable masters together, without creating empty records.'}</p>
    <Link className="btn-secondary min-h-11" href="/company/import">{ar ? 'استيراد الحزمة الجاهزة' : 'Import prepared kit'}</Link>
  </section>;
}
