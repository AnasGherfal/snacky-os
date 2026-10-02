import Link from "next/link";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, SearchParamsRecord, totalPages } from "@/lib/pagination";

type PaginationControlsProps = {
  basePath: string;
  searchParams: SearchParamsRecord;
  page: number;
  pageSize: number;
  totalCount: number;
  itemLabel?: string;
};

function toUrlSearchParams(params: SearchParamsRecord) {
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((item) => urlParams.append(key, item));
    } else {
      urlParams.set(key, value);
    }
  }
  return urlParams;
}

function pageHref(basePath: string, searchParams: SearchParamsRecord, page: number, pageSize: number) {
  const params = toUrlSearchParams(searchParams);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function hiddenFields(searchParams: SearchParamsRecord) {
  return Object.entries(searchParams).flatMap(([key, value]) => {
    if (key === "page" || key === "pageSize" || value === undefined || value === "") return [];
    if (Array.isArray(value)) {
      return value.filter(Boolean).map((item) => <input key={`${key}-${item}`} type="hidden" name={key} value={item} />);
    }
    return <input key={key} type="hidden" name={key} value={value} />;
  });
}

export function PaginationControls({
  basePath,
  searchParams,
  page,
  pageSize,
  totalCount,
  itemLabel = "records",
}: PaginationControlsProps) {
  const pages = totalPages(totalCount, pageSize);
  const safePage = Math.min(Math.max(page, 1), pages);
  const firstRow = totalCount === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastRow = Math.min(safePage * pageSize, totalCount);
  const previousPage = Math.max(1, safePage - 1);
  const nextPage = Math.min(pages, safePage + 1);
  const canGoPrevious = safePage > 1;
  const canGoNext = safePage < pages;

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
      <div>
        Showing <span className="font-medium text-slate-900">{firstRow}</span>-<span className="font-medium text-slate-900">{lastRow}</span> of{" "}
        <span className="font-medium text-slate-900">{totalCount}</span> {itemLabel}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form action={basePath} className="flex items-center gap-2">
          {hiddenFields(searchParams)}
          <input type="hidden" name="page" value="1" />
          <label htmlFor="pageSize" className="text-slate-500">Rows</label>
          <select id="pageSize" name="pageSize" defaultValue={String(pageSize || DEFAULT_PAGE_SIZE)} className="field-input h-10 w-24 py-1">
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <button className="btn-secondary h-10 px-3 py-1" type="submit">Apply</button>
        </form>
        <div className="flex items-center gap-2">
          {canGoPrevious ? (
            <Link className="btn-secondary h-10 px-3 py-2" href={pageHref(basePath, searchParams, previousPage, pageSize)}>Previous</Link>
          ) : (
            <span className="inline-flex h-10 items-center rounded-lg border border-slate-200 px-3 py-2 text-slate-400">Previous</span>
          )}
          <span className="min-w-20 text-center text-slate-500">Page {safePage} of {pages}</span>
          {canGoNext ? (
            <Link className="btn-secondary h-10 px-3 py-2" href={pageHref(basePath, searchParams, nextPage, pageSize)}>Next</Link>
          ) : (
            <span className="inline-flex h-10 items-center rounded-lg border border-slate-200 px-3 py-2 text-slate-400">Next</span>
          )}
        </div>
      </div>
    </div>
  );
}
