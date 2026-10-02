import { CompanyDocuments } from '@/components/CompanyDocuments';
import { CompanyKitImportAction } from '@/components/CompanyKitImportAction';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <><CompanyKitImportAction/><CompanyDocuments searchParams={params}/></>;
}
