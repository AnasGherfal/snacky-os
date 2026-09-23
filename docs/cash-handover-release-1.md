# Cash handling — release 1

## Scope

A mobile Arabic/English workspace at `/cash-handling` connects **existing** cash
collection records to assignment, unattended drop-off, acknowledged pickup and
one confirmed count. It is not a second Finance ledger. Routes, product buying,
stock adjustment, CRM, historical cash rows, and general roles are not rewritten.

The feature starts **off**. No account is granted counting access by migration.
Owners/admins can manage the pilot and grant this one capability to an active,
linked operator, warehouse, purchasing, supervisor or finance account. A pure
coordinator should not receive the Finance role. Existing Finance permissions on
an account are not revoked by granting/removing this additional capability.

The original collection form remains the entry point. A direct machine collector
still needs its existing collection permission (for example the operator role).
Every removal uses a new collection/seal reference, even when reusing a box.

## Physical workflow

1. Record sealed removal through the existing cash removal screen.
2. Owner assigns a coordinator; alternatively the collector chooses an authorized
   coordinator at the first unattended drop-off.
3. Collector records the exact secure location and a photo. The record explicitly
   says the box was deposited **without claiming another employee received it**.
4. Assigned coordinator verifies the physical box reference and seal, then records
   pickup. This changes custody, not money.
5. Coordinator enters one physical total and where the counted money is kept.
   Zero is valid for an empty box. Purchases/expenses must never be subtracted.
6. The current automatic-period counting RPC and existing Finance trigger post the
   counted total. Completion requires exactly one active Finance link with the
   exact amount. VMS data is not required to count; owner reconciliation stays in
   the original workspace. Seal exceptions stay flagged for owner review.

A coordinator who personally collected a box can acknowledge **direct custody**
and count without a fictional storage visit. Revoking access does not transfer
physical custody: an owner must record a real takeover with a reason and box
verification, or arrange a handover before revoking access.

Counted cash remains with the named custodian / at the entered location. “Posted
to Finance” is not a bank deposit or proof that the owner physically received it.

## Security and integrity

- Private tables with RLS and no direct browser grants. Public wrappers are
  invokers calling private definers with explicit stored-profile authorization.
- Scoped data projection. Operators see their own custody records without amounts;
  coordinators see assigned records and their own counts, never company balances
  or VMS expected amounts. Owners/admins see the team queue.
- General `finance.view` / `finance.edit` and raw Finance policies are unchanged.
- The existing count and Finance posting functions have narrow authorization
  extensions: a delegated count must have a private pending request for the same
  actor, collection, and current database transaction, plus acknowledged custody.
  A direct RPC call cannot manufacture that context.
- All box transitions lock the existing cash collection row. Per-request locks,
  exact actor/payload binding and revisions protect duplicate and competing saves.
- An enrolled box cannot be counted through a legacy form that bypasses pickup.
  Confirmed amounts cannot be silently overwritten. The existing owner void and
  later reconciliation procedures remain available.
- No money is posted on assignment, drop-off or pickup. Count, Finance linkage,
  audit events and request receipt either commit together or roll back together.
- Uncertain requests are retained in the browser tab's session storage, scoped to
  the signed-in user. Retry recovers the original receipt, rather than issuing a
  new operation. Previously committed drop-offs can recover without another photo.
- Photos are private. Read URLs are short-lived and signed only after record
  authorization. Browser photos up to 10 MB are resized when necessary; uploads
  are capped at 3 MB plus metadata to stay below the hosting request limit.
- Potentially committed evidence is never deleted after an ambiguous error.
  Failed retries can leave unreferenced private images; future cleanup must compare
  stored references before deleting anything. No automatic deletion is included.

## Verification and release gate

`node --experimental-strip-types --test scripts/test-cash-handover.mjs` tests the
command and UI contracts. `Cash handover isolated acceptance` replays repository
migrations into a disposable loopback backend using the existing documented QA
bootstrap (`docs/company-qa-environment.md`), then tests real authenticated RPCs,
concurrent submissions, failed Finance posting rollback, permissions/revocation,
legacy workflows, a production build, phone RTL forms, private evidence and a
lost-response retry through the real UI. The repository-wide regression workflow
runs independently. CI acceptance uses synthetic accounts and no production keys.

Do not call this ready until those jobs pass. Review the diff, current base branch
and deployment preview, then apply the reviewed migration with the matching app.
The production database must not be used for fixtures or failure injection.

For the pilot, enable only after verifying the chosen employee has an active
linked account and no unintended Finance role. Test one real sealed box end to
end, compare its single Finance entry and check the operator cannot see amounts.
Only then extend use to the remaining cash collections.

Pausing stops **new enrollment** but deliberately permits open boxes to finish.
Do not revert the application to a version without Cash handling while enrolled
uncounted boxes remain. Keep the compatible screen available, finish or explicitly
resolve open custody, then roll back application changes if needed. Preserve audit
history; never delete private tables or rewrite historical amounts as rollback.

Later releases: assigned purchasing, approved inventory counts, CRM dispatch.
No phone push notifications or scheduled collection tasks are added in release 1.


## Production preflight: unidentified older records

A read-only preflight on 2026-09-23 found 33 uncounted records, of which 32 had
no recorded physical box/seal reference. These are **records**, not proof of 32
physical boxes or a confirmed shortage. No amounts, labels, roles, or ownership
were inferred or changed.

Unidentified records remain visible as **Earlier record · reference missing**.
The database rejects all new handover actions on null, empty, or whitespace-only
references, even for owner/admin accounts or direct RPC calls. The UI provides
an English/Arabic review notice rather than inventing a label. Existing owner
reconciliation/count/void workflows remain the review path. Do not create a new
collection to replace an old record: that could duplicate the accounting.

After a referenced box is enrolled, its physical reference is immutable. Pickup
uses a null-safe comparison. Receipt recovery still occurs before new action
validation so a committed retry does not duplicate work.

The migration is still unmerged/unapplied; these guards were added to the same
reviewed release migration, not as a rewrite of production historical data.
Local-only regressions cover null, empty, spaces, tabs/newlines, forced commands,
no ledger side effects, legacy owner count, immutable references, and bilingual
phone review screens. Passing test results must be verified for the new head;
earlier acceptance results alone do not cover this change.
