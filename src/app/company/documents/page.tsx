import { CompanyDocuments } from '@/components/CompanyDocuments';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CompanyDocuments searchParams={await searchParams} />;
}
