import { companyMasterUrl, companyUuid, type CompanyItem } from './company-hub';

/** Presentation only. The authenticated Company RPC/file API remains the access boundary. */
export function companyDocumentFile(item: CompanyItem): string | null {
  return companyUuid.test(item.data.file_id ?? '') ? `/api/company/files/${item.data.file_id}` : null;
}
export function companyDocumentMaster(item: CompanyItem): string | null {
  try { return companyMasterUrl(item.data.source_url ?? '') || null; } catch { return null; }
}
export function companyDocumentReady(item: CompanyItem): boolean {
  return !item.archived && item.current_version > 0 && Boolean(companyDocumentFile(item) || companyDocumentMaster(item));
}
export function companyDocumentQuery(params: Record<string, string | string[] | undefined>) {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
  const rawOffset = typeof params.offset === 'string' ? params.offset : '0';
  const offset = /^\d+$/.test(rawOffset) ? Math.min(100000, Number(rawOffset)) : 0;
  return { q, offset: Number.isSafeInteger(offset) ? offset : 0 };
}
export function companyDocumentHref(q: string, offset = 0): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (offset > 0) params.set('offset', String(offset));
  return `/company/documents${params.size ? `?${params}` : ''}`;
}
