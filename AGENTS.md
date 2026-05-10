# Snacky OS — Agent Instructions

You are building Snacky OS, an internal operating system for Snacky, a vending machine company in Libya.

## Business Goal

Snacky is building a modern vending machine network that can scale from 8 machines to 100+ machines. Do not build only a dashboard. Build an operating system.

The core workflow is:

VMS data → Refill recommendations → Route creation → Operator execution → Inventory movement → Cash reconciliation → KPI dashboard

## Tech Stack

Use:

- Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- Server Actions / Route Handlers
- Mobile-friendly PWA for operator screens

Do not use Firebase.
Do not use Google Sheets as the main system.
Do not build a native mobile app yet.

## Core Business Rules

1. Inventory must be ledger-based using `inventory_movements`.
2. Never update inventory only by editing a stock number.
3. Stock must move through:
   - Supplier → Storage
   - Storage → Operator Bag
   - Operator Bag → Machine
   - Operator Bag → Storage
   - Machine → Waste / Expired / Damaged
4. Refill recommendations must come from:
   - machine_slots
   - latest VMS stock snapshots
   - par quantity
   - min quantity
   - storage availability
5. Operator should not decide what to take. The system tells the operator.
6. Cash collection must compare:
   - VMS expected cash
   - actual cash collected
   - variance
7. Issues must have:
   - priority
   - status
   - assigned user
   - SLA due date
8. Critical issues should be due within 24 hours.
9. Cosmetic/normal issues should be due within 72 hours.
10. Owner/admin/supervisor can manage operations.
11. Operators can only access assigned routes and execution screens.
12. Do not expose supplier costs or profit data to operators.

## MVP Goal

The MVP is successful when:

1. Admin can create machines, products, locations, suppliers, and machine slots.
2. Admin can upload VMS stock CSV.
3. System maps VMS products to Snacky products.
4. System generates refill recommendations.
5. Admin can generate a route from recommendations.
6. Operator can view today's route.
7. Operator can see what to take from storage.
8. Operator can complete machine refill tasks.
9. Inventory movements are created automatically.
10. Operator can enter cash collected.
11. System calculates cash variance.
12. Operator can report issues with photo upload.
13. Dashboard shows low stock, open issues, route status, sales, variance, and machine performance.

## Development Rules

- Make small commits.
- Build feature by feature.
- Run lint/typecheck/build after major changes.
- Do not add unnecessary dependencies.
- Keep code readable.
- Prefer server-side data loading where possible.
- Use Supabase Row Level Security for permissions.
- Keep operator UI simple and mobile-first.
- MVP should be useful before it is beautiful.
- Do not commit real secrets, API keys, VMS passwords, Supabase service role keys, or private credentials.

## Build Order

1. Database schema
2. Master data CRUD
3. VMS import
4. Product mapping
5. Refill recommendations
6. Route creation
7. Operator workflow
8. Inventory movements
9. Cash reconciliation
10. Issues
11. Dashboard
12. Auth and permissions
13. RLS policies
14. Tests
15. Deployment
