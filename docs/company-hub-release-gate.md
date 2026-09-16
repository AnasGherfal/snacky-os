# Company Hub release acceptance

## Two separate decisions

**Code merge readiness is not permission to enable the feature for staff.**
The current decision, exact reviewed commit, workflow runs, unresolved blockers and
visual evidence must be recorded in PR #173. Do not reuse a green result from an
older application commit as approval for newer code.

A merge candidate must pass its exact-head checks, preserve existing workflows,
remain disabled by default, and have no unresolved feature-critical functional or
security finding. Activation additionally requires the deployed database's CRM
prerequisites, the Company migration, approved materials, real staff assignments,
backup/restore readiness, a rollback plan and owner acceptance of the interface.
No production database or data mutation is authorized by this document.

## Code gates

- Run the repository-wide node:test sweep; identify any skipped integration cases
  and execute them separately against the disposable real backend. Keep original
  business assertions or document why a legacy fixture no longer represents the
  existing protected contract. Do not weaken a ledger/API guard to make tests pass.
- Run Company and CRM scenarios before and after the Company migration in isolated
  PostgreSQL. Run the real application with real local Auth, REST and Storage;
  test staff authorization, draft isolation, publish/revision safety, search,
  upload/download/preview, old versions, acknowledgements, notifications, archive,
  deactivation and lost-response recovery.
- Verify important existing purchase, route, pickup, inventory, permissions and
  VMS import behavior. Build with Company enabled for its acceptance suite and
  disabled for the native-workflow suite. Company must not create money/stock
  movements or an independent operational task ledger.
- Production and full dependency audits must be reviewed. Unresolved high/critical
  findings block release. Use pinned, reviewed fixes and a lockfile; never bypass
  the gate or run a blind force-upgrade.
- Inspect actual full-shell Arabic/English mobile and desktop screens, not only
  mocked cards. Check navigation, labels, RTL, focus/contrast, long content,
  loading/error/empty/retry states, previews and multipage printing. Report the
  scope of any automated accessibility scan accurately.

## Publication safety

Management reviews the exact saved draft, revision, attachment, audience, owner,
sharing choice and notification/acknowledgement effects before publishing. A
concurrent edit invalidates that review. Historical instructions show an explicit
older-version warning and a route to current instructions. Read/acknowledge/task
completion remain different actions. Generic starter wording is never adopted
as company policy automatically.

## Deployment gates

1. Confirm the reviewed base/head and assess any concurrent application changes.
2. Inspect the current deployed schema and migration prerequisites read-only.
   The prior connected-relations release must exist before Company. Never apply
   all pending historical files blindly.
3. Verify backups and restoration of both database records and file objects.
4. Coordinate the reviewed schema and application deployment with the feature off.
   Verify owner, relations, operator and mixed/inactive access before staff rollout.
5. Load/review the approved logo, presentation and role procedures. Configure
   underlying Drive permissions for master links. Keep private employee records
   outside the general library. Obtain owner visual acceptance.
6. Enable the feature deliberately. Keep a tested application rollback path;
   retain private versions, history and receipts rather than dropping their data.

## Evidence limits

See `docs/company-qa-environment.md` for the explicit differences needed to build
the disposable full-schema test environment and the read-only verified production
permission baseline. These tests are real local integration, not a production
clone, production deployment or proven disaster recovery. Dependency scans and
passing tests reduce risk; they cannot guarantee absence of every future defect.

The first release does not include task-based onboarding automation, recurring
escalations, scheduled external Company notifications, private HR document
management or Drive synchronization. Those require their own implementation and
acceptance evidence, not an untested claim of completion.
