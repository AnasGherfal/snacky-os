# Buying receipt verification record

Feature: one assigned buyer records the store receipt and may also confirm physical placement in storage. The feature remains a draft pull request and has not been deployed to production.

## Verified before phone-control correction

Run `35995185632`, source `148f1f9a74581473c3fda269f012ab666013b1a0`, tested merge `bd25368f614a98398cc361de59e9f7bb988583ab`:

- 46/46 focused receipt, existing buying/source/print and authorization tests passed.
- TypeScript and focused ESLint passed.
- Existing route-ledger regression contracts passed. The earlier critical-workflow phase passed seven tests and skipped its one local-environment-dependent purchase test; the actual purchase database acceptance subsequently ran separately.
- 250 SQL files replayed on disposable Supabase with the repository harness's documented bootstrap differences.
- All 16 actual Auth/Storage/PostgreSQL scenarios passed, including same-person receiving, exact replay, unauthorized access rejection, approved alternative suppliers, no premature stock, invoice corrections with preserved cancellation history, and transaction rollback after an injected failure.
- The production Next.js build passed before browser execution.

The first browser test stopped because the store selector's implicit accessible label included its option text. The actual English receipt page rendered, and the failed-run screenshot confirmed the selector was present. This was not recorded as a passed browser test.

## Corrected controls

Commit `475b0cdd350acd1783b57b467fb4419477eb65a4` gives the store and both storage-location selectors explicit, distinct English/Arabic accessible names. A regression test checks those labels. Visible wording and purchasing behavior are unchanged.

The corrected head must complete the real browser tests for multipart receipt upload, a deliberately lost response and exact retry, the same buyer confirming storage, Arabic 390/320-pixel viewports, accessibility, and denied Finance/cross-origin access. Refer to the current CI result rather than treating this verification note as a blanket pass.

## Boundaries

No production migration, role change, receipt, stock movement, payment, or PR merge is performed by these tests. Supplier payments remain in the existing authorized purchase-payment workflow. No independent receiver is required; a physical-storage confirmation is still required before stock is added.
