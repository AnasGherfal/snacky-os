# Route Smoke Test

Run this checklist before marking any Snacky OS task that touches routes as complete.

## Scope

Route stability comes before optional features. Old routes and newly-created routes must both load without runtime errors, 404s, invalid UUID errors, ON CONFLICT errors, movement enum errors, or optional-data crashes.

## Owner/Admin Smoke Test

1. Open `/routes`.
2. Confirm the route list loads, including old assigned, active, completed, cancelled, and unknown-status routes if present.
3. Open at least three old routes:
   - One pending or assigned route.
   - One in-progress or pickup-confirmed route if present.
   - One completed route.
4. Confirm each route detail page renders even when optional data is missing:
   - Distance or payroll fields.
   - Inventory movements.
   - Damaged/returned adjustments.
   - Extra products.
   - Refill history/photos.
   - Product category.
   - Machine/location display data.
5. Open `/routes/new`.
6. Create a new route with at least two machine stops.
7. Confirm the new route saves and redirects to `/routes/[route_id]`.
8. Return to `/routes` and confirm the list still loads.
9. Open the new route detail and confirm stops and route stock render.

## Operator Smoke Test

1. Sign in as an operator with route access.
2. Open `/operator/routes`.
3. Confirm assigned routes, unassigned/open routes, and completed assigned history render.
4. Open a route.
5. Confirm the pickup list loads.
6. Confirm pickup.
7. Open a stop execution page.
8. Save filled quantities.
9. If adjustment features are enabled, add one damaged or returned item and confirm failures are user-readable.
10. Complete the stop.
11. Complete remaining stops.
12. Complete the route.
13. Refresh the operator route and admin route pages.

## Required Pass Conditions

- Old route list and details load.
- New route creation succeeds.
- `/routes` still loads immediately after creating a route.
- Operator route list and route detail load.
- Stop page loads without `refillHistory is not defined`.
- Completion redirects to valid `/operator/routes/[route_id]` or `/routes/[route_id]` pages.
- No route workflow screen depends on optional data joins.
- Optional feature failures log internally and fall back safely.

## Optional Feature Status Gate

If any optional feature causes load or save instability, disable or isolate it before release:

- Damaged products.
- Returned-from-machine products.
- Extra filled products.
- Refill history/photos.
- Inventory movement summaries.
- Route distance/KM meter/oil tracking.
- Payroll distance summaries.
- Leftover warnings.

Do not mark route work complete until this checklist passes for old routes, new routes, and the operator workflow.
