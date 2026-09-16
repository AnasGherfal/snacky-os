# Company Hub — release hold and acceptance standard

**Status: DRAFT / DO NOT MERGE OR ENABLE.** The owner requested a higher release
standard after the initial implementation. A passing build is not a release
approval. Keep this PR in draft until the evidence below is complete and reviewed.
No production database changes, permissions, operational records or employee
policies are authorized by this checklist.

## Findings reproduced during the review

1. A published page could show version 1 while its Publish latest draft button
   published a different saved draft. The review view must show the exact saved
   body, file, audience, owner, sharing choice and notification/acknowledgement
   effects before allowing publication. The existing revision lock must reject
   a concurrent edit. Saving now opens that private review view, and successful
   publication returns to the current published record.
2. Historical instructions lacked a conspicuous warning and a direct route to
   the current version. Older versions must stay accessible as history without
   masquerading as the current instructions or prompting current-policy consent.
3. Relations staff saw duplicate My Work buttons on their Company home screen.
   Show one primary daily-work action and use employee-facing language.

The dedicated regression tests were first run against the original head and
failed on these gaps. They execute the actual server component with controlled
framework/data boundaries. They do not prove production-account access.

## Gates

- **Scope and data:** review the exact base/head diff; do not change route,
  pickup, stock, purchase, cash, payment, payroll or VMS behavior to accommodate
  Company. No duplicate operational ledgers, tasks or contacts. Use synthetic
  records only in tests. Keep the feature disabled by default.
- **Before/after database regression:** the release runner applies the actual
  migrations in isolated PostgreSQL, runs Company invariants, then reruns the
  original CRM scenarios after the Company migration. This matters because the
  migration touches the shared CRM storage/API guard. It is not sufficient to
  test those original scenarios only before the migration.
- **Security:** production dependency audit must not have unresolved high or
  critical findings. Audit failure is a release blocker, even if inherited from
  the base branch; it is not proof the new feature introduced the issue. Do not
  run a force-upgrade or bypass the check. Triage exact locked versions, repair
  with a reviewed patch and rerun the full regression suite.
- **Real staging integration:** on a nonproduction database and the matching
  application, verify login, active/inactive staff, owner/admin, relations,
  operator and mixed-role access; private draft search/file isolation; uploads,
  download and preview; publication, concurrent edits, reloads and timeouts;
  per-version acknowledgements; notification recipient scope; archive/restore;
  company-disabled and database-unavailable behavior. Review any differences
  between live/staging helper definitions and the simplified isolated fixtures.
- **Existing workflows in staging:** route creation, partial/multiple-stop
  pickup, stop completion and evidence; storage and reservations; supplier
  payment; cash removal/counting; customer issue handoff/resolution; lead
  conversion; rent proof versus verified Finance payment. Match before/after
  ledger totals. No live money or stock may be moved merely to demonstrate QA.
- **Presentation:** inspect full app-shell screens, not only component cards,
  in Arabic and English, at phone and desktop sizes. Check RTL, typography,
  visible tab/breadcrumb context, keyboard/focus behavior, long names/text,
  loading/error/empty states, disabled and retry states, the notification panel,
  PDF/image preview, and multipage printing. No fake buttons or placeholder
  resources presented as approved material. Obtain owner visual acceptance.
- **Content/setup:** approved current logo, presentation, role pack and contact
  information must be supplied and reviewed. Generic templates are not approved
  company policies. Sensitive employee files remain outside the general library.
- **Deployment:** verify migration prerequisites, backing database and file
  restoration, exact reviewed commit, feature enablement and rollback plan.
  Merge approval and staff rollout approval are separate. A preview deployment
  is not production deployment evidence.

## Evidence boundary

The initial 15 green workflows did not establish the real-account/staging,
production-dependency or owner visual gates. This review must not reuse an older
screenshot or PR description as proof that a later code change was tested.
Record the exact commit, date, environment, commands, failures and remaining
blockers when updating this PR. Never label a partial or mocked test end-to-end.

Follow-on functionality (onboarding task packages, recurring responsibilities,
escalations, external Company notifications, global search, private HR documents
and Drive synchronization) remains separate scope until implemented and tested.
