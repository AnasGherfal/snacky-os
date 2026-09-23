# Cash and buying rollout preflight — 2026-09-23

## Observed, not inferred

Read-only production inspection found both feature migrations absent, and the
older shared-buying schema/RPCs absent. Existing required profile, team, product,
cash, Finance and private evidence objects are present. Active accounts inspected
have active linked team records. No employee has been chosen as the coordinator
and no new staff permissions have been granted.

There are 33 uncounted cash records in removed/in-storage states. Of these, 32
have no recorded physical box reference: 21 have review_status=pending_collection
and 11 have review_status=collected_pending_count. Their recorded dates span
May 24–June 19, 2026. All 32 are route-linked. This is not proof of physical boxes,
a loss, or newly removed cash. Do not fabricate box IDs or copy these into new
collection records. The release now marks them for existing-owner review and
rejects every delegated handover command for a missing reference.

## Exact scoped prerequisites

Apply only the reviewed versions, after all required checks and release review:

1. `20260920133731_shared_buying_lists.sql` (already on master; absent in production).
2. `20260923120059_cash_handover_coordinator_v1.sql` (PR 206, with legacy-reference guards).
3. `20260923130938_buying_store_guidance_v1.sql` (PR 207).

Do not replay unrelated historical migrations against production. Check the
current CRM pre-request guard before its additive buying allowlist changes.
Existing cash and Finance functions must match the reviewed baseline before
extending their counting authorization. This plan is not proof of deployment.

## Release gates

The original heads passed a combined isolated rehearsal (run 35869195586),
but that result does not cover the subsequently discovered missing-reference
case. The corrected head must pass new cash acceptance and a new combined
cash/buying rehearsal, plus the existing repository and cross-module checks.

Verify the exact final source blobs and migration text, not only an earlier PR
status. Check production migration presence and the matching app deployment
separately; a successful Vercel build does not install SQL.

## Pilot boundaries

Keep new cash handovers disabled initially; no counter grants, historical
enrollment, supplier selections, physical custody acknowledgments, cash counts,
stock movements, or financial entries are created by rollout. Choose one active
linked coordinator without general Finance access. Use one genuinely identified
sealed collection, and verify exactly one corresponding Finance entry after the
real count. This physical acceptance cannot be simulated on production.

Use one real assigned buying list with owner-selected suppliers and price dates.
Checklist results remain separate from purchase receiving, payments and inventory.
The four usual stores have not been guessed. Existing ledger data must remain
unchanged by feature installation.

Pausing cash stops new enrollment while allowing enrolled custody to finish.
Do not roll back the app to a version without Cash handling while any enrolled
uncounted boxes remain. Preserve event history and all existing financial rows.
