# Snacky OS — Machine photo product recognition (beta)

## Purpose
Operators already photograph the final machine during the route. Snacky can now use that **saved photo** to propose which SKU is visible in each XY selection and offer a review-and-apply flow for changed products.

One front-on photograph often shows **the front-facing product only**. It does not reliably reveal how many are behind the visible item; **never derive sellable stock from the photo**.

## Operator path
1. Open assigned machine stop, physically fill the machine and record actual refills, returns and damages through the existing operator workflow.
2. Take the required **Refill proof** photograph after loading, from as straight-on a view as possible. Confirm Snacky says **Photo saved**.
3. Below the photo, click **Scan saved machine photo**.
4. Read summary: matches current XY, proposed product changes, unrecognized lanes.
5. Review **each suggested change** against what is actually loaded. Correct the proposed SKU from the dropdown if necessary.
6. Enter **actual physical final count** for the specific lane (count physically; do not estimate from the image).
7. Check that old stock was physically removed and accounted for where necessary, and explicitly approve the SKU/quantity.
8. Click **Apply reviewed changes to XY** once. Snacky reuses the existing authenticated, vendor-verified slot-change endpoint, with deferred writes disabled.
9. Check the current XY quantities with the separate **Refresh & verify XY** step before closing the stop.

## Safety guarantees
- Recognition endpoint runs **server-side**, uses `OPENAI_API_KEY` and existing confirmed XY product mappings, never trusts unrestricted AI product IDs, never sends any XY write.
- A missing or inaccessible saved proof image, offline XY, missing product catalog, unclear image, invalid/duplicate slot, or unrecognized product yields no automatic write.
- Suggestions remain advisory regardless of model confidence; no unattended vendor commands or photo-inferred stock counts.
- Only explicitly selected and reviewed product changes can reach the existing guarded XY API.
- Each lane needs a manually entered quantity and explicit physical old-stock acknowledgement. No auto-queued offline vendor commands (`queueOnOffline: false`).
- Stop on the first failed or unverified XY change; completed ones are marked locally so they are not blindly re-applied.
- Nothing in the AI step silently changes product purchases, cash, storage, or operator bag inventory. Returned/damaged old stock must be booked via existing inventory adjustments.
- Camera/lighting, brand variants, glare, handwritten labels, sparse XY lane numbering and occluded rows can all cause errors. Model output is never authority for actual stock.

## Configuration
- Existing server-only `OPENAI_API_KEY` must be set in Snacky OS's runtime environment.
- Optional `XY_PHOTO_VISION_MODEL=gpt-4.1-mini`.
- Existing XY VMS integration and Supabase private refill photo bucket must work.
- Zero additional database migrations or API keys exposed in browser.

## QA checklist
- [ ] The final proof photo is saved; no duplicate photo required.
- [ ] Missing photo: scan disabled with explanation.
- [ ] Clear machine photo: some visible slots detected; every result has a real slot code and catalog product.
- [ ] Multiple selections of the *same* product remain distinct.
- [ ] Hidden/unclear/missing slots are explicitly marked unrecognized.
- [ ] Detection with strong evidence still requires physical confirmation.
- [ ] No quantity is inferred from photo.
- [ ] Wrong product suggestion can be corrected before submitting.
- [ ] A stale or absent XY layout blocks detection safely.
- [ ] Quantity > lane capacity, blank quantity, and missing physical confirmation prevent changes.
- [ ] Offline XY during apply does not enqueue a delayed write.
- [ ] Successful vendor write is verified via readback.
- [ ] Return/removal ledger entries are manually recorded for old stock before approval.
- [ ] Existing refill workflow, payout, cash and inventory remain unchanged.
- [ ] End-to-end test with real products is conducted under supervision before production release.

## Limitations
The model currently analyzes the **single saved completion photo**. For large 40–60 lane machines, a wider high-resolution image or several close-ups may be necessary before recognition accuracy is sufficient to trust in daily operations. A calibrated camera angle/planogram and a verified product photo reference library would improve accuracy.

No real vendor read, machine photo recognition performance, or physical product accuracy can be claimed from static CI tests alone; production integration needs a valid backend key and a supervised field test.
