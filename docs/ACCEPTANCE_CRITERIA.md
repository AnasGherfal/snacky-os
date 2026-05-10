# Snacky OS Acceptance Criteria

## MVP Acceptance Criteria

Snacky OS MVP is accepted when all items below work locally with seed data and can work with real data after configuration.

### Master Data

- Admin can create, edit, and archive locations.
- Admin can create, edit, and archive machines.
- Admin can create, edit, and archive products.
- Admin can create, edit, and archive suppliers.
- Admin can create and edit machine slots / planograms.

### VMS Import

- Admin can upload VMS stock CSV.
- System parses uploaded rows.
- System detects unknown machines.
- System detects unknown products.
- Admin can map VMS products to Snacky products.
- Stock snapshots are stored.
- Refill recommendations update after import.

### Refill Recommendations

- System shows machine, slot, product, current qty, par qty, suggested qty, available storage, and priority.
- Critical stockouts are shown first.
- Suggested qty is not negative.
- Final qty does not exceed available storage.

### Routes

- Admin can generate a route from selected recommendations.
- Route has operator, date, stops, refill orders, and refill lines.
- Pick list aggregates product quantities across all stops.

### Operator Workflow

- Operator can see assigned route.
- Operator can confirm pick list.
- Operator can complete each machine stop.
- Operator can enter actual filled quantities.
- Operator can enter cash collected.
- Operator can complete cleaning checklist.
- Operator can report issues.
- Operator can return leftovers.

### Inventory

- Pick list confirmation creates Storage → Operator Bag movements.
- Refill completion creates Operator Bag → Machine movements.
- Leftover return creates Operator Bag → Storage movements.
- Inventory balances are calculated from movements.

### Cash

- System stores VMS expected cash.
- Operator enters actual cash collected.
- System calculates variance.
- Variance above threshold is flagged for review.

### Issues

- Operator can create issues with priority and photo.
- Issue SLA due date is calculated.
- Dashboard shows open and overdue issues.

### Dashboard

- Dashboard shows machines needing refill.
- Dashboard shows critical stockouts.
- Dashboard shows low storage products.
- Dashboard shows open issues.
- Dashboard shows route status.
- Dashboard shows cash variances.
