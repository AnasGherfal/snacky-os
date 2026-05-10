# Snacky OS Starter

This is the first technical skeleton for Snacky OS: a vending operating system for machines, products, storage, VMS stock snapshots, refill recommendations, operator workflow, cash reconciliation, and issues.

## What this starter includes

- Next.js app structure
- Supabase/Postgres schema
- Demo seed data
- Owner dashboard
- Machines page
- Products page
- Inventory view
- Refill recommendations view
- Operator workflow placeholder
- VMS import workflow placeholder

## Requirements

Install these first:

1. Node.js LTS
2. Git
3. VS Code
4. Docker Desktop
5. Supabase CLI using `npx supabase`

## Setup from zero

### 1. Install dependencies

```bash
npm install
```

### 2. Start Supabase locally

```bash
npx supabase init
npx supabase start
```

If the project already has a `supabase` folder, `supabase init` may tell you it is already initialized. That is okay.

### 3. Reset database and load schema + seed

```bash
npx supabase db reset
```

This applies the migration and seed data.

### 4. Get local Supabase keys

```bash
npx supabase status
```

Copy:

- API URL
- anon key

Create `.env.local`:

```bash
cp .env.example .env.local
```

Then paste the real local values inside `.env.local`.

### 5. Run the web app

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## First pages to check

- `/dashboard`
- `/machines`
- `/products`
- `/inventory`
- `/refills`
- `/operator`
- `/vms-import`

## Core system principle

Do not manually edit inventory quantity. Use `inventory_movements`.

Correct flow:

```text
Supplier → Storage → Operator Bag → Machine → Sale
```

## Next build priorities

1. Real product/machine/location data
2. VMS CSV upload parser
3. VMS product mapping screen
4. Generate refill orders from recommendations
5. Operator pick list and refill completion
6. Cash collection variance screen
7. Auth + roles + Row Level Security before public deployment

## Important security note

This starter is for local development. Before deploying to production, add authentication, role-based permissions, and Supabase Row Level Security policies.
