# Snacky OS — Refill verification acceptance test

## Release state
QA-only branch until owner acceptance. Do not deploy to operators or create fictitious production routes/stock movements just to test UX.

## Simulation (zero production side effects)
Once the preview build is available, sign in and visit `/operator/verification-test`.
This is a **local-browser mock route**, not a database route, and never sends XY vendor commands.
Press **Reset test route** to return to known fixtures.

### Stop 1 — Same snack, multiple selections
- Selection 001: Cola physical 8 / XY 8 => verified.
- Selection 003: Cola physical 8 / XY 0 => **should flag 003**, not merge Cola totals with 001.
- Select **Simulate updating this XY selection** for 003, then Refresh. Both should verify.
- Change 003 XY to 7: should flag expected 8 / actual 7.
- Change actual filled for 003 to 7: should invalidate the previous result until Refresh.

### Stop 2 — Partial fill and forgotten item
- Juice 011: planned 6, actually filled 4 / XY 4 => correct physical fill; **shortage banner** must remain for pickup accountability.
- Snack 012: planned 5, actually filled 0 => no physical addition, so not mistaken for sellable stock. Shortage banner must remain.
- Set actual filled Snack 012 to 5 with XY 0 => mismatch; update simulated XY to 5 and refresh => verified.
- Exercise corrections without resetting other stops.

### Stop 3 — Wrong product in a selection
- 021: expected Water 10 but simulated XY product Cola 10 => **product mismatch despite identical quantity**.
- Set the XY product to Water; Refresh => verified.
- Confirm selections are identified by code, not only product total.

### Summary
- View **Test route summary** after visiting all stops.
- All three should show verified only after deliberately resolving flagged differences.
- Clicking Reset must clear all test state (including previous acknowledgements).

## Supervised real machine readback (after CI / preview checks)
On a real operator route with exact XY lane allocations, and only when a responsible manager has approved testing:
1. Open the route's machine stop on a phone.
2. Fill an assigned lane and record what was **actually** placed in that exact selection in Snacky.
3. Update the quantity on the machine itself, as normally done.
4. Tap **Refresh & verify XY · read only**.
5. Expect a green verified result only if the direct XY read returns the same selection quantity and mapped product.
6. Deliberately leave **one lane unupdated** during a supervised, non-customer-facing test; it should show expected vs actual discrepancy. Correct it at the machine and retry before making it sellable.
7. Try multiple selections carrying the same SKU, a partial fill, incorrect SKU mapping, XY unreachable, and missing exact lane assignments.
8. When verification cannot pass, use **Continue with XY verification pending** only as an explicit exception. Confirm it shows up in the owner quantity-updates queue.
9. Check any user-entered `Change Quantity` edits separately because that feature can **queue real XY writes**, unlike this read-only button.
10. Confirm inventory ledger, operator bag, cash, route history, and live vending status remain consistent. Do **not** use real customer transactions as test data.

## Known limitations / nonclaims
- Direct XY refresh is a vendor cloud read; it may lag device propagation. No vendor-provided last-device-sync timestamp is validated by this feature yet.
- Product identity is checked only for assigned selections that have a valid mapping from XY product ID to Snacky product. Unmapped or ambiguous identities fail closed.
- The readback compares currently planned exact lane quantities (previous recorded stock + actual per-lane fill). If inventory sold or changed between planning and verification, reconcile the live baseline rather than overriding blindly.
- A readback cannot prove that the *physical* snack matches the machine label. Photograph/problem-report product swaps separately.
- Existing `Complete Stop` and `Change Quantity` code still has independent asynchronous XY stock synchronization. The **read-only refresh button** itself never sends XY changes.
- The simulated route does not verify a real machine, server authorization, vendor connectivity, or ledger posting. Production readiness requires a supervised end-to-end check.
