# CRM collaboration acceptance

The dedicated release workflow must pass three independent checks on the exact release head:

1. Real SQL: inherited CRM/company/lead-focus migrations plus the new collaboration migration in disposable PostgreSQL. Verify author/owner note visibility, owner replies, CRM-only buying denial, retained operational buying, labels before paging, optimistic revisions, retries, deactivation, archive, and unchanged source CRM/Finance records.
2. App: actual API validation and role behavior, existing CRM/buying/access contracts, TypeScript, focused ESLint, critical workflows, and final production build without test-only routes.
3. Phone components: production notes and labels components rendered with synthetic API fixtures in English and Arabic at 390px/320px. Verify restored note and label drafts, stable accessible form names after reload, response-loss replay, unavailable-read retry, owner response and staff visibility, and no serious/critical accessibility findings.

The store-guided buying integration suite now tests that a CRM-only account cannot be selected as a buyer. It retains the original reassignment/access/privacy assertions using a warehouse employee as the valid new buyer. It also verifies the denied assignment leaves the previous assignee and revision unchanged.

Screenshots in CI are synthetic test records, not real customer/employee conversations. They do not establish that a real staff account has completed the workflow. After coordinated database/app deployment, the CRM employee should enter her first real note and label; owner/admin should confirm the same note and personal label organization are visible without needing external messages.

No migration or test should fabricate business activity in production. Do not report the new UI live while its PR remains unmerged. Do not report the database ready from a frontend build alone: verify the installed RPCs, private table permissions, unchanged native workflows and live migration identity separately.
