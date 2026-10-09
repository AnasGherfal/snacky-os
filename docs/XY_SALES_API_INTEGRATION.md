# XY transaction API integration — verification record

Verified against the public XY dashboard JavaScript assets on 2026-10-09 (read-only GitHub Actions scan).

## Vendor interface

- The vendor's transaction detail screen issues an authenticated **POST** to
  `/service-order/jqjymx/queryJqjymx` on `xcx.xynetweb.com`.
- Its request includes `pageNum`, `pageSize`, `starttime`, `endtime`, and filtering fields.
- The public web application stores a vendor-issued `session_key` in browser session storage as `Authorization`.
- The login UI includes a **four-digit verification code**, so the normal interactive dashboard login cannot be assumed to be an unattended service-account authentication mechanism.
- Other public endpoints are `/service-api/kcj/queryDdxxV2` and `/service-order/jqjytj/selectJqShTj` (order data and merchant totals), but these are *not* yet proven substitutes for transaction-level details.

The above proves the endpoint exists in XY's web application; it **does not** prove that Snacky has a valid merchant-scoped sales authorization. Do not state that sales data is connected until an authorized, non-empty transaction response has been verified.

## Supported Snacky code

`src/lib/xy-live-sales-sync.ts` already requests that endpoint with server-only
`XY_WEB_API_AUTHORIZATION`, paginates transaction details, normalizes statuses, and writes
the existing `vms_transactions_raw` transaction ledger with deduplication.

Sales ingestion is intentionally disabled by default:
`XY_WEB_ENABLED=false`, `XY_WEB_LIVE_SALES_ENABLED=false`.

**Required for activation:** Obtain XY-issued, authorized merchant-scoped sales API access
or a supported service account/session renewal mechanism. Set credentials in secure
server environment settings, not in the Git repository, public browser JavaScript,
GitHub Actions logs, or client-visible `NEXT_PUBLIC_` settings. Validate the
transport and merchant scope before enabling the cron job.

## Production acceptance criteria

1. Successful authorized response with actual transaction IDs, machine IDs, dates,
   payment statuses and settled amounts for a test window.
2. Vendor pages are exhausted; a max-page cutoff is an error, not a completed sales window.
3. Rejected/unidentifiable records mean coverage is *unverified* even if other sales were imported.
4. Import the same window twice; duplicate transaction rows and revenue totals do not change.
5. Verify machine and day totals against the official XY dashboard report, including refunds and failures.
6. Verify Snacky OS in-app 24-hour no-sales notifications only arise from complete recent sales coverage.
7. If vendor authentication expires, suspend no-sales conclusions and show a sales feed warning.

## Follow-up with XY

Ask XY to issue documented machine-scoped and merchant-scoped **read-only transaction API access** for Snacky, including allowed authentication / refresh process, rate limits, pagination, transaction status codes, cash transaction coverage, and historical access. A personal dashboard session copied from a browser is not reliable permanent integration.
