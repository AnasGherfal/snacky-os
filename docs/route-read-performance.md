# Route read performance — 29 September 2026 (Tripoli)

## Scope

Route-specific read policies still executed profile/role helpers for each item after the earlier shared CRM-boundary optimization. Eight SELECT policies now evaluate row-independent role checks once per statement, with an explicit CASE retaining the original per-route operator check for everyone else. Role sets, restrictive boundaries, grants and all write policies remain unchanged.

The route list now reads stop/machine/location labels together while fetching operator names in parallel. This removes one sequential database round trip on the normal path. Existing legacy-schema fallback is retained and shares a five-second deadline across optional summary queries. Network/permission errors are not retried as schema errors. Unknown stop counts are not displayed as zero. Authoritative route reads remain authenticated/RLS-filtered; support lookups stay scoped to that page's authorized IDs, matching the pre-existing server-only support-client boundary. There is no shared cache.

## Production database measurements

Each target was tested three times before and after using EXPLAIN ANALYZE under the same owner profile. Values below are medians of execution time, not browser or HTTP response time.

| Target | Before ms | After ms | Rows |
| --- | ---: | ---: | ---: |
| Route-item reservation read | 804.603 | 7.045 | 5,176 |
| Route-stock reservation read | 581.842 | 4.952 | 3,945 |
| Completed-route pick list | 5.465 | 1.074 | 32 |
| Basic route list | 1.444 | 1.470 | 25 |

The first post-change reservation executions were 286.158 ms and 59.373 ms, respectively; do not describe every request as a 5–7 ms request. The basic route-list database read was already fast: its frontend waterfalls and network overhead are a separate issue.

## Verification

- Before/after visible-row hashes matched for all eight affected tables across all nine existing profiles: 72 comparisons, zero mismatches. Tested owner, operators, a warehouse/operator combination, viewer, investor, CRM and inactive profiles.
- No route, inventory, cash or finance records were changed by this migration. No pickup/completion/stock writer was altered.
- Eight local helper tests cover joined normal reads, empty pages, legacy-schema fallbacks, scoped IDs, shared deadlines and no retry on denied/network/timeout responses.
- Full application build and existing ledger checks must pass in GitHub before merging frontend code.

## Limits

These are database and mocked-loader tests, not authenticated end-to-end timings on a user's phone. The larger route-detail page still has sequential loaders; this patch does not claim that every route page is now instant. Migration history and frontend deployment must be checked separately.
