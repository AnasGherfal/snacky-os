# CRM notes, personal lead labels and buying access

## Why CRM saw buying lists
The previous shared-buying release explicitly included the CRM role in its app allowlist, sidebar and database member helper. The active CRM profile did not need any extra purchasing role to see the list. This change removes that automatic privilege. Existing combinations remain additive: an employee explicitly given warehouse/purchasing/operator/finance responsibilities retains the relevant buying workflow. No employee roles or old purchases are deleted.

## Notes to management
Open `/my-work/notes` from Customer Relations, My Work, or Owner Operations. A compact summary shows the number requiring attention; an unavailable read is unknown, never zero.

CRM can create a general note or open the note composer from a lead's Labels panel. Notes are visible only to their author and active owner/admin accounts. They are not public comments and are not visible to operators, finance, pure supervisors or another CRM author.

The original note text stays unchanged. Owner/admin can reply and mark New, Seen / in review, or Done. Review history is recorded privately; stale revisions and changed request retries are rejected. The author sees the response and status on the next read. These notes are not automatic tasks, lead stage changes or customer outreach.

This release does not send a phone push on each management note/reply. It provides the shared inbox and pending summary, not a new chat or messaging service.

## Personal lead labels
On Leads & Visits, CRM can create, rename or archive her own colored labels and apply up to ten to a lead she already has native edit permission to. Examples could be 'This week', 'Needs a visit' or 'Waiting for owner'—the release does not manufacture these labels in production.

The label filter is applied by the database before pagination, so it searches the whole authorized lead set rather than only visible rows. Labels are displayed beside lead information. Owner/admin can inspect label names and authors and filter by them. Other CRM employees do not receive access to another employee's private organization. Owner/admin inspection does not overwrite the employee's own label definitions.

Management-assigned focus, lead stage, responsible employee and follow-up date remain separate and unchanged. Archived labels stop appearing without deleting any lead or audit history.

When a label filter is selected, an absent/disabled label-capable reader is an explicit unavailable result, never a fallback to the unfiltered legacy list. Standard lists still retain their existing no-label fallback. Label controls appear only after the reader has returned label metadata.

## UX and reliability
- Compact cards, inline lead labels, narrow-phone layouts and Arabic RTL.
- Notes use ten records per page; lead lists retain their existing bounded paging.
- Note, response, label-definition and selected-label drafts are kept in the current browser session. They are not cross-device or offline synchronization.
- Exact pending commands are persisted before submission. A lost response retries the same request; no optimistic 'Saved' is shown without a matching database receipt.
- Read failures keep an explicit retry state. Older requests cannot overwrite newer filters.
- No extra dependency is added to the app. Existing focus controls use client-only draft restoration without synchronous effect state cascades.

## Database/security
Private tables have RLS and no raw browser grants. Public wrappers are SECURITY INVOKER. Private functions validate active canonical profile/team identity and native lead access. UI, route handler and database independently enforce the appropriate boundaries. Role decisions never use editable user metadata or a caller-supplied employee selector.

No Finance/inventory/cash writers are added or altered. No stock quantity, cash count, buying receipt or customer repair is fabricated. The new migration changes the buying member/picker restriction and extends only the existing lead reader and CRM RPC allowlist at checked anchors.

## Verification and rollout
Dedicated checks execute original CRM and lead-focus migrations plus this actual migration in an isolated PostgreSQL fixture. Tests cover private notes, owner replies, role revocation, additive buying roles, labels before pagination, idempotency, stale requests, archive and source-record no-write guards. UI tests render real components with synthetic API responses in English/Arabic at 320/390px; these are not a physical employee-phone acceptance test.

Keep the PR draft until all exact-head checks pass. Deploy the reviewed SQL and matching app together. A successful frontend build does not install the database. The migration creates no production notes, labels, tasks or assignments. The first real note and labels should be entered by the staff member herself.

Rollback: remove new navigation/components, revoke the collaboration wrappers if retiring the feature, preserve private note/label history, and keep the corrected CRM buying boundary. Do not reinstate CRM purchasing just to hide an unrelated UI problem. Source CRM commands and management focus remain unchanged.
