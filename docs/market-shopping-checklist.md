# Market shopping checklist

## Purpose and workflow

The editable market checklist records what the buyer needs to find. A row can name an exact product, a product family such as **Bebeto - any flavour**, or a general need such as **Chips - any suitable brand**. An optional catalogue product is a preferred example. Checking a row does not assert that this exact SKU was purchased.

The buyer can add, edit and remove needs while shopping, record partial quantities, mark unavailable items and check completed needs. Remaining items include unavailable needs so they are still visible when the buyer visits another store. A trip may be completed when every active row is either fully acquired or explicitly unavailable. A partially acquired row must be resolved first.

Shopping quantities retain their units: boxes, packs or units. Totals across different units are not presented as a stock quantity. Changing a row's unit requires its acquired quantity to be reset in a separate saved action first, preventing two acquired boxes from silently becoming two acquired packs.

Record the actual purchased products, flavours, pack sizes, prices and receipt through the existing Purchases flow. Inventory increases only through the established purchase receiving operation. Checklist edits, ticks, completion and assignment do not create purchases, inventory movements or payments.

## Using the list

From **Purchase List**, choose **Open shopping checklist**. Add free-text needs, choose their flexibility and units, and adjust quantities. The default **Remaining** view keeps unmet needs visible; tick a fully acquired item or record a partial quantity as you shop.

The initial draft stays on the current device. **Save to Snacky** opens a shared list that can be used from other devices. Sales suggestions can explicitly add new recommendations without overwriting manual edits or shopping progress. **Record receipt** opens the ordinary purchase flow for the exact items actually bought.

## Additive data model

The migration adds `shopping_mode boolean not null default false` to `buying_private.lists`. All existing exact-product lists retain their prior mode and item records.

New market lists use `buying_private.checklist_items`. Each row has an independent ID within its list, an optional `product_id` reference, label, requested quantity, unit, flexibility, acquired quantity, unavailable flag and note. Ordering and creator/updater audit fields are stored separately. Removal sets `removed_at` and `removed_by`; it does not delete the historical row. The existing exact-product `buying_private.items` table is unchanged.

The table has RLS enabled and no direct grants to `anon`, `authenticated` or `PUBLIC`. The public RPC functions use `SECURITY INVOKER`. Their private implementations use the existing active-member and purchasing-role checks with a fixed empty search path. Operator-only and CRM-only accounts remain excluded; additive purchasing roles continue to work.

## RPC contract

`snacky_buying_checklist_command_v1(p_command jsonb)` accepts:

```json
{
  "request_id": "a client-generated UUID kept unchanged for retries",
  "list_id": "a client-generated list UUID",
  "revision": 0,
  "action": "create",
  "payload": {}
}
```

The response contains `request_id`, `list_id` and the resulting `revision`. Creation starts at revision 1. Every other successful command increments the current revision once. A retry with the identical command and actor returns the original response; changing an existing request identity is rejected. The request lock uses the existing buying-command namespace. Each list is locked while checking its revision and writing changes.

The item DTO contains exactly these fields:

```ts
{
  id: string;
  product_id: string | null;
  label: string;
  quantity: number;
  unit: "boxes" | "packs" | "units";
  flexibility: "exact" | "any_flavour" | "any_brand";
  acquired_quantity: number;
  unavailable: boolean;
  note: string;
}
```

Quantities are whole numbers: requested quantity is 1-10,000 and acquired quantity is 0 through the requested quantity. `unavailable=true` requires an acquired quantity of zero. Labels have 1-160 characters and notes at most 1,000. A supplied product reference must identify an existing catalogue row; an inactive product remains a valid preferred example so saved drafts can still be published and edited. Unknown product IDs are rejected. This does not change the catalogue validation for actual purchases or receipts. A list can contain at most 200 active rows and a command can contain at most 400,000 UTF-8 bytes.

| Action | Payload | Authorization |
| --- | --- | --- |
| `create` | `title`, `instructions`, `assigned_to`, `due_on`, `items` | Planner; revision 0; 1-200 items |
| `add` | `{ item }` | Planner or assigned buyer; open list |
| `edit` | `{ item }` | Planner or assigned buyer; open list |
| `progress` | `item_id`, `acquired_quantity`, `unavailable`, `note` | Planner or assigned buyer; open list |
| `remove` | `{ item_id }` | Planner or assigned buyer; open list; soft removal |
| `complete` | `{}` | Planner or assigned buyer; no unresolved active rows |
| `assign` | `{ assigned_to }` | Planner; open list; active eligible recipient |
| `cancel` | `{ reason }` | Planner; open list; reason retained in command history |
| `reopen` | `{}` | Planner; completed lists only |

Being a list's creator provides visibility but does not by itself permit edits after losing the planner role. Reassignment removes the prior buyer's access unless that person independently remains authorized. Replay also rechecks current access. Mutating requests require a current revision of at least 1 and below the integer overflow boundary.

## Workspace and counts

The existing `snacky_buying_workspace_v1` response is extended through a private wrapper which first delegates to the installed workspace implementation. Existing visibility, list filters, ordering and available buyer choices are preserved.

Market-mode records return `items: []` and `checklist_items` containing only active rows, in their saved order. Every checklist item has exactly the nine DTO keys above; database audit columns are not included. Legacy records keep their exact-product items and return an empty `checklist_items` array.

Market list records and listing rows include these counts:

| Field | Meaning |
| --- | --- |
| `item_count` | Active shopping needs |
| `acquired_count` | Needs whose acquired quantity equals the requested quantity |
| `remaining_count` | Unmet needs, including unavailable needs |
| `unavailable_count` | Needs explicitly marked unavailable |
| `checked_count` | Fully acquired or unavailable needs; used for trip completion |

## Receipt and legacy protection

The predecessor receipt implementations and their quantity/snapshot triggers remain unchanged. Checked private entry points explicitly reject market-mode lists before delegating to those implementations for legacy lists. Direct authenticated execution of the predecessor private receipt functions is revoked, preventing bypass of the mode check. Public receipt RPC permissions otherwise remain the same.

A list-status trigger enforces market completion even if an older client calls the legacy completion RPC, which would otherwise see no exact-product rows. It also prevents a list from switching modes. No historical list is converted or backfilled.

## Verification

`scripts/test-market-shopping-checklist-db.sql` runs the actual legacy buying, supplier-guidance, receipt, membership and new market-checklist migrations against a small disposable fixture. It refuses databases not named `market_checklist_tests` and refuses an existing profile or buying schema.

Run against a fresh local PostgreSQL database using the same connection environment as other database tests:

```bash
createdb market_checklist_tests
PGDATABASE=market_checklist_tests psql -X -v ON_ERROR_STOP=1 -f scripts/test-market-shopping-checklist-db.sql
```

When native PostgreSQL is unavailable, an optional local runner creates and destroys a private PGlite database. The test dependency is installed outside the application:

```bash
npm install --prefix /tmp/snacky-checklist-db-tests --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.5.13
SNACKY_PGLITE_MODULE=/tmp/snacky-checklist-db-tests/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-market-shopping-checklist-db.mjs
```

The suite covers generic and family rows, exact replay, creation rollback, malformed fields, role and assignment isolation, partial/unavailable progress, unit changes, soft removal, list summaries, legacy completion bypass, receipt separation, absence of stock/money writes and unchanged legacy receipt guards. PGlite provides a real PostgreSQL engine in one connection; the replay and stale-revision assertions do not claim to test multi-session scheduling.

## Rollout

The additive migration is `20261028160233_market_shopping_checklist.sql`, generated with the Supabase CLI. Apply this reviewed migration after the existing buying-list, receipt and role-restriction migrations, then deploy the matching application. Preserve checklist and command records during application rollback. Local verification does not establish that a migration or deployment has been applied to production.
