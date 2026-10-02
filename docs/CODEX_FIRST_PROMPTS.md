# Codex First Prompts

## Prompt 1 — Inspect Only

You are working on Snacky OS.

Before coding, read:
- AGENTS.md
- docs/CODEX_BUILD_STRUCTURE.md
- docs/BUSINESS_RULES.md
- docs/OPERATOR_WORKFLOW.md
- docs/VMS_IMPORT_SPEC.md
- docs/ACCEPTANCE_CRITERIA.md

Then inspect the repo.

Do not change code yet.

Return:
1. Current project structure
2. Current database structure
3. Missing files
4. Missing features
5. Recommended first coding task
6. Risks or unclear requirements

Snacky OS is an internal operating system for a vending machine company in Libya. The core workflow is:

VMS data → refill recommendations → route creation → operator execution → inventory movements → cash reconciliation → KPI dashboard

The system must be designed to scale from 8 machines to 100+ machines.

## Prompt 2 — Phase 1 Database

Now build Phase 1 only.

Goal:
Create or improve the Supabase PostgreSQL schema for Snacky OS.

Use the requirements from:
- AGENTS.md
- docs/CODEX_BUILD_STRUCTURE.md
- docs/BUSINESS_RULES.md

Build tables for:
- locations
- machines
- suppliers
- products
- team_members
- storage_locations
- machine_slots
- vms_product_mappings
- vms_import_batches
- vms_stock_snapshots
- vms_sales_snapshots
- inventory_movements
- routes
- route_stops
- refill_orders
- refill_order_lines
- cash_collections
- issues
- purchase_orders
- purchase_order_lines

Also create views for:
- current_inventory_by_location
- refill_recommendations

Add seed data using sample Snacky data.

Done when:
- Supabase migrations run successfully
- Seed data loads successfully
- Refill recommendations view returns rows
- No TypeScript or SQL errors
