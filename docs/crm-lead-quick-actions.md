# Lead working-list and quick updates

## Live sorting repair

The merged focus UI was using its legacy fallback because the production project lacked the reviewed lead-focus migration. Installed that already-merged update separately, reconciled its receipt to 20260919162204, and verified owner/CRM-member reads. No declined row remained on page one; the original declined record was last in All and excluded from Open. Source statuses were not rewritten. Full fingerprints for leads, tasks, routes, inventory movements, Finance and the original CRM read/write functions matched before and after repair. These checks used current database role context, not an observed signed-in production browser.

## Application changes

Open opportunities is the normal starting view. Explicit All records, Installed and Declined views preserve history. Selecting a specific stage keeps the visible lifecycle tab consistent rather than accidentally intersecting Declined with Open. Search and filtering remain server-side and retain existing permissions.

Quick update opens from a row without leaving the working list. It loads the latest authorized record, then offers one small action: log contact, update the next step, edit contact details, change stage with a reason, or manager assignment. Each action submits one existing audited CRM command. Logging a call does not send anything, automatically change the stage, or finish a task. Stage reasons append to existing notes and audit history. Agreed is not installed; installation requires an already-linked location. Closed records do not offer a prospecting-deadline action until reopened.

The dedicated lead detail layout keeps the same read boundary and original forms for complete editing, notes, scheduled follow-ups, conversion, linked tasks, contacts, documents, history paging, management bonus tracking and archive/restore. The other CRM workspaces remain byte-for-byte unchanged. Closed lead summaries are distinct from active next steps. Existing financial and operational writers are not replaced.

## Save behavior

The quick panel persists the exact command with a per-user, per-lead browser key before submission. A lost response keeps that request for retry even when decline or reassignment removes the row from the current list. Success requires the exact command and record receipt. Stale changes cannot overwrite a newer version. A successful save is followed by a clear return-to-work action that refreshes the original filters; it does not silently reclassify another record.

This UI PR has no new database migration. The prior missing focus migration was repaired separately. Full testing occurs with synthetic records and local disposable services; no real customer call, decline or assignment is simulated in production. Consult the PR for actual final check results and deployment status. This file alone is not evidence that the UI has been merged or activated.
