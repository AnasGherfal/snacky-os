export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
// Bound offsets from untrusted URLs without changing ordinary pagination.
export const MAX_PAGE = 10000;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export type SearchParamsRecord = Record<string, string | string[] | undefined>;
function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
function positiveInteger(value: string | string[] | undefined, fallback: number) {
  const text = firstParam(value) ?? '';
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export function getPagination(searchParams: SearchParamsRecord) {
  const requestedPage = positiveInteger(searchParams.page, 1);
  const page = requestedPage <= MAX_PAGE ? requestedPage : 1;
  const requestedPageSize = positiveInteger(searchParams.pageSize, DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize as PageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}
export function totalPages(totalCount: number | null | undefined, pageSize: number) {
  const count = Number(totalCount ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(count / pageSize));
}
export function cleanSearchParams(searchParams: SearchParamsRecord) {
  return Object.fromEntries(Object.entries(searchParams).filter(([, value]) => {
    if (Array.isArray(value)) return value.some((item) => item !== '');
    return value !== undefined && value !== '';
  })) as SearchParamsRecord;
}
export function supabaseLikePattern(value: string) {
  return `%${value.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}
