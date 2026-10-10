# Snacky OS — Machine photo product recognition (beta)

## Purpose
Operators already photograph the final machine during the route. Snacky can now use that **saved photo** to propose which SKU is visible in each XY selection and offer a review-and-apply flow for changed products.

One front-on photograph often shows **the front-facing product only**. It does not reliably reveal how many are behind the visible item; **never derive sellable stock from the photo**.

## Owner-only photo library AI test (no machine required)
- Open `/operator/verification-test` in the Snacky preview.
- As owner/admin, the first card says **Test with a photo from your library**.
- Tap **Choose photo from library** and select an old vending photo from iPhone Photos. **No camera capture** is required.
- Preview the photo, then tap **Analyze photo with AI (test only)**.
- Snacky returns recognized active Snacky products with approximate visible row/position and visual evidence plus confidence. Duplicate products in multiple visible selections remain distinct.
- This is real AI image analysis, not the mock quantity comparison; the vision model needs server-side `OPENAI_API_KEY`.
- iPhone HEIC images are converted to JPEG in the browser where the browser can decode them; if not, export as JPEG. Large images are downsized client-side to stay under request limits.
- The photo is sent to the AI provider only for analysis (`store:false`), **never saved to Snacky Storage**, and **never used to issue an XY command**.
- Positions are intentionally **visual estimates**. The owner is away from the physical machine; without its verified slot mapping there is no safe way to claim a precise XY lane identity or product count.
- Access to the AI test endpoint is restricted to signed-in active owner/admin accounts; the card is hidden from other roles.

## Passport-style guided camera (included in the regular refill photo)
- Tap **Open guided machine camera** on the existing Refill proof step.
- Choose **Standard machine** or **Wide machine** to adjust the on-screen alignment frame.
- Hold the phone in portrait and stand directly in front of the machine, not sideways.
- Move backwards until **all four corners of the cabinet**, every product row, and the bottom of the machine are visible inside the green frame. The amber corners show the frame endpoints.
- Avoid people in the background, glare on the glass, darkness and motion. Move the camera slightly or improve lighting if the glass reflects brightly.
- Capture and review the photo before saving. A small client-side check provides advisory warnings for severe darkness, glare or blur; these are not proof that the machine is aligned or every product is readable.
- The operator confirms full-machine coverage and can **Retake** without uploading. Camera permissions are requested only on opening the guided camera.
- If browser live camera is unavailable or permission is denied, use **Use phone camera / gallery instead**. This cannot overlay the frame inside the native camera but permits a manual visual check of the photo.
- The visual overlay is **not baked into the photo** and does not crop the image. Full-resolution video frames are captured first, then compressed to retain additional product-package detail within the existing secure refill-proof storage workflow.
- Photo saved → existing AI SKU recognition → explicit per-selection review and approval → guarded XY change (if needed). No separate redundant proof image is created.

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
