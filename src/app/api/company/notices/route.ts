import { companySession, companyJson } from '@/lib/company-server';
export const dynamic = 'force-dynamic';
export async function GET() {
  const session = await companySession();
  if (!session) return companyJson({ error: 'Not available.' }, 403);
  const result = await session.db.rpc('snacky_company_notices_v1');
  if (result.error || !result.data)
    return companyJson(
      {
        error:
          'Company updates are unavailable. This is not confirmation that there are no updates.',
      },
      503,
    );
  return companyJson(result.data);
}
