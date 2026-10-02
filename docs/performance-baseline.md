# Snacky OS performance baseline

Baseline created after the route-builder UX correction on master.

This document is deliberately **structural**, not a claim about production latency. Static query counts and file size tell us where to measure first; they do not prove that a page is slow.

## Current hotspots

| Area | Source size | Static DB call sites | Await sites | Why it matters |
| --- | ---: | ---: | ---: | --- |
| VMS import actions | ~279 KB | 95 | 168 | Largest server-side action surface and highest async/query density |
| Operator actions | ~134 KB | 86 | 107 | Core operator workflow; high regression risk |
| Route detail | ~77.6 KB | 35 | 18 | Read-heavy page with many independent data dependencies |
| VMS import page | ~110.4 KB | 21 | 27 | Large page plus many async reads |
| Dashboard | ~52.7 KB | 20 | 14 | High-frequency page; already parallelizes many reads |
| Route creation form | ~145 KB | 8 | 4 | Very large client component; UX/render hotspot rather than DB hotspot |
| Refills | ~26.3 KB | 15 | 10 | Moderate read density |
| Inventory | ~34.0 KB | 4 | 5 | Lower static query density |

Run:

```bash
npm run audit:performance
```

For machine-readable output:

```bash
node scripts/audit-performance-baseline.mjs --json
```

## Protected workflows

Performance work must not casually change:

- inventory ledger semantics
- route reservations and pickup
- operator custody
- machine inventory commits
- purchase/finance posting
- cash reconciliation
- stop completion and recovery

Any optimization touching those paths must preserve existing contracts and pass the relevant regression suites before merge.

## Optimization order

1. Measure real page/request latency for Dashboard, Route Detail, VMS Import, Inventory and Refills.
2. Remove duplicate or unused reads without changing returned business data.
3. Reduce payload width where a page selects columns it never renders.
4. Defer non-critical secondary panels only when UX remains clear.
5. Split giant UI/action files only after behavior is locked by tests.
6. Consider database views/RPC consolidation only after measurement shows query round trips are the bottleneck.

## What this first phase intentionally does not do

- no database migration
- no Supabase schema changes
- no route or inventory behavior changes
- no finance changes
- no UI redesign
- no cache policy change
