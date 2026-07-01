# Route Smoke Test

Run this checklist whenever a change touches routes, pickups, stops, or route completion.

## Required Checks

- [ ] Admin route list loads without `Could not load routes`.
- [ ] Admin can create a route.
- [ ] Operator route list loads assigned routes.
- [ ] Operator can open a route detail page.
- [ ] Pick list loads.
- [ ] Pickup confirmation saves.
- [ ] Continue route works.
- [ ] Stop page loads.
- [ ] Filled quantities save.
- [ ] Stop completion works.
- [ ] Route completion works.
- [ ] Refreshing a completed route still loads the summary.

## Optional Features

- [ ] Damaged products are isolated from the core route flow.
- [ ] Returned products are isolated from the core route flow.
- [ ] Extra-filled product handling is isolated from the core route flow.
- [ ] Route distance and oil meter features are isolated from the core route flow.
- [ ] Inventory movement, leftovers, and finance extras do not block route loading.

## Expected Failure Policy

If any optional feature fails, the route must still load and the core workflow must remain usable.
