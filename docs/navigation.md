# Snacky OS navigation

The sidebar, header, breadcrumbs, desktop section tabs and mobile menu use one registry: `src/components/module-tabs-config.ts`. Do not add separate URL/role maps to individual shell components.

## Workspaces

| Workspace | Contents |
| --- | --- |
| Dashboard | Main overview |
| Operations | Routes/refills, field work, stop override and historical refill recovery |
| CRM & Support | Leads/visits and customer issues |
| Machines & Locations | Operating machines, sites, planograms, status and maintenance |
| Inventory & Purchasing | Stock/checks/movements, products, supplier purchases, suppliers and planning |
| Cash Custody | Collection history and recording cash removal |
| Finance | Ledger, expenses, commercial planning, investors/payroll, imports/review and financial reports |
| Reports | Sales, monthly operations, product activity, analytics and cash reconciliation |
| Administration | Team, settings, audit log, integrations and diagnostic tools |
| My Account | Account, app installation and eligible staff's own profile/money page |

Investor-only users retain their separate Investor Portal. Roles determine visible destinations, not a different ownership map. Finance and purchasing users enter Purchasing rather than a forbidden inventory index. The legacy `?module=finance` query does not switch purchase navigation. Existing page URLs, permissions, server authorization, session checks and business workflows remain unchanged.

## Navigation rules

- Specific child routes beat parent routes. Only one item is active in each strip.
- CRM customer issues do not switch to Machines. Purchases do not switch to Finance.
- Keep at most six sections per workspace and six links per section. Group additional tools deliberately.
- All workspace/section/tab labels have Arabic equivalents. Use logical start/end positioning for RTL.
- Desktop navigation is collapsible; mobile navigation uses the same destinations in a focus-contained drawer and section selector.
- A permitted individual record can retain its workspace without exposing a forbidden parent index. Contextual links do not grant permissions.
- Breadcrumbs replace obsolete workspace labels but preserve record names and permitted record ancestors supplied by pages.
- No database migration is required for this change.

## Validation

Run `node --experimental-strip-types --test scripts/test-app-navigation.mjs scripts/test-app-navigation-context.mjs scripts/test-app-navigation-breadcrumbs.mjs`, then `npm run typecheck` and `npm run build`.

The App navigation checks workflow also renders the real ShellChrome, Sidebar, Topbar, navigation components, I18nProvider and compiled production CSS in Chromium. Its isolated harness adapts Next routing to browser history and replaces session/XY/notification network boundaries; it does not add a production test route or bypass authentication. Tests cover every visible destination for every role, CRM/purchase transitions, browser history, mobile focus/Escape, RTL placement, widths down to 320px and sidebar persistence. Screenshots and results are retained as `navigation-review` artifacts. These are component/browser checks, not a claim of production database end-to-end testing.
