# Company Hub audit findings and narrow compatibility repairs

The exact tested commit and workflow results are recorded in PR #173. This document describes why changes were made; it is not approval to migrate or enable production.

## Company feature repairs

The audit tightened draft review before publication, historical-version warnings, active linked-staff authorization, bounded streamed request bodies, download filename handling, stable contextual-help associations, human-readable role/workspace labels, contrast/focus, and normal-flow multipage printing. Real isolated Auth/REST/Storage/browser tests exercise saving, reload, publication, private files, search, acknowledgements, archive, deactivation and a lost response after a real commit. No alternate money, stock or operational task ledger was introduced.

## Dependency repair

Dependency manifests and the lockfile use reviewed pinned versions. The vulnerable npm-channel spreadsheet package was replaced with the maintained SheetJS distribution with integrity recorded in the lockfile. Tests round-trip actual legacy BIFF8 .xls and modern .xlsx bytes, Arabic text, leading-zero identifiers, zero quantities, decimals and merged monthly-report titles through the existing parser. Production and full dependency audit outputs are retained in CI. Zero known audit findings do not establish the absence of undisclosed vulnerabilities.

## Dashboard route read compatibility

Real integration exposed two pre-existing read problems. The dashboard's route query joined team_members ambiguously even though routes has several foreign keys to that table, and selected routes.updated_at even though the connected production schema has no such column. Read-only production inspection verified both facts. The two query shapes now explicitly use routes_operator_id_fkey and omit the unused missing field. Route creation, completion, inventory, cash, payroll and payment writers are not altered by this read repair.

## Weekly sales dispatch defect

The detailed-order integration fixture already contains Cargo Lane Number and maps it to cargo_lane_number correctly. Its failure was initially suspected to be a fixture mismatch. Investigation instead found a real pre-existing dispatcher defect: the vms_order_details_weekly branch executed planogram logic, demanded slot_code and appended machine-layout rows, while no dedicated weekly transaction rows were created.

The repair restores separate weekly-transaction and planogram branches. Weekly rows reuse the existing order-details aliases, date/quantity/status interpretation and duplicate hash; they enter the existing transaction persistence, deduplication and batch-postcondition pipeline. The monthly transaction branch is unchanged. The planogram branch retains its required slot checks and layout payload. No imported live history, source prices or prior batch is rewritten by this code change.

Tests explicitly verify the existing weekly classification for success, failed payment, failed vend, refund and review states. The real HTTP import test checks three persisted weekly transactions, their exact paid total of 11, quantity total of 4 and lanes A1/A4/B1, and compares machine layouts before/after to prove this sales import does not alter them. These figures and records are synthetic test fixtures, not Snacky financial data. Do not relax the test to accept a failed batch or change the fixture to make sales look like a planogram.

## Test-environment boundaries

See company-qa-environment.md for the documented historical empty-bootstrap exceptions and the read-only verified production permission baseline. The tests use real disposable services, not mocked success responses, but are not a byte-identical production clone or disaster-recovery demonstration. The legacy stock-refresh diagnostic can emit a schema warning in that fresh environment; native acceptance verifies the actual latest-stock source and refill recommendation view rather than treating the diagnostic as evidence of successful data refresh.

The broader source sweep identifies integration-only skips and runs those suites separately on the real local backend. Features are tested enabled and disabled. Older fixture adaptations are explicit and preserve required authorization, canonical writers, genuine pickup acknowledgements and strict persisted VMS batch checks. Temporary branch-writing preparation workflows are removed from the final change.

## Merge versus activation

A reviewed code merge must keep Company disabled until the earlier connected-relations prerequisites and Company schema are applied in a coordinated deployment. The connected production database was inspected read-only; the prerequisite CRM functions were absent. No production migration, staff assignment, approved policy publication, file upload, permission change or money/stock movement was performed by this audit. Approved materials, backup/restore verification and final staff rollout remain deployment tasks, not implied by CI success.
