# Snacky — feasibility of local XY sales capture without paid cloud sales API
**Evidence review: 2026-10-09. Status: research / hardware validation needed.** This is not a working live integration.

## Summary

Hunan Xingyuan's *VMC — Upper computer V3.0 0411* protocol visibly describes read-only machine-side sales totals using query types 0x43 (day), 0x44 (month), 0x45 (year), 0x46 (machine lifetime) and 0x47 (selection sales). The response is an 0x71 packet containing raw counters and amounts. The VMC ↔ upper-computer interface is RS232 57600, 8-N-1, with a packet protocol and 200ms VMC-led polling.

Sources:
- Vendor-branded protocol transcription: https://www.scribd.com/document/759944671/VMC-Upper-Computer-V3-0-0411
- Vendor XY-DLE-10C-L operator manual (a different/older hardware family; do not assume Snacky's model matches): https://www.scribd.com/document/813168666/XY-DLE-10C-L-1-2

**Evidence ≠ confirmed access.** No physical Snacky controller has been reached; actual board firmware, accessible serial pins, telemetry scale and byte order, and remote connectivity are all unverified.

## Important limitations

1. The serial link is ordinarily already connected to the vending machine's existing *upper computer* (Android/display controller). Interfering with 200ms polling could disrupt payment or vending. **Never attach a competing serial transmitter to a working machine or send test commands on a live operating machine.** Prefer board-manufacturer supported mirror/DEX output or a passively isolated serial capture on an uninstalled spare.
2. The protocol warns that some deployments manage pricing and inventory in the upper-computer application, not the VMC. Prove that the VMC's daily counters actually increment after a cash vend; do **not** assume hardware counters reconcile to the XY cloud dashboard.
3. Daily/monthly/total sales are **aggregates**, not individually timestamped vend rows. Selection (0x47) also has aggregate count and amount only. This is suitable for a potential 24h inactivity indicator or daily cash totals, *not* a guaranteed transaction-by-transaction ledger.
4. The XY-DLE-10C-L manual lists an optional/configured DEX data-collection jack. This does **not** prove Snacky's current machines have a working DEX port. A vendor USB "Export System Config" option covers machine configuration, not necessarily sales; do not label it a sales export.
5. Endianness and monetary scaling cannot be determined confidently from the available text. The offline decoder deliberately shows both 32-bit interpretations and **does not** convert amounts to LYD.
6. Hardware access on its own is not Internet access. A separate, secure, network-enabled local collector or an officially supported Android-board data export would be needed for automatic remote Snacky alerts.

## Low-risk field pilot, in order

1. Use **one uninstalled spare**. Photograph the **VMC board's model + firmware sticker**, existing controller connectors, and any labelled DEX/audit/RS232 outputs. Do not disconnect wires or change settings on a machine taking customer payments.
2. Confirm board revision and protocol with XY from existing sales/support channels, asking only about local sales data access, not paid **cloud** API credentials. Ask whether DEX/EVA-DTS or a separate read-only serial monitoring port is supported and if it provides daily cash totals.
3. Ask whether the installed Android upper-computer application itself offers export of daily transactions to USB, SD, CSV or a documented local network socket. This may be easier/safer than a VMC hardware interface.
4. If a manufacturer-supported non-disruptive read-only channel is available, capture sanitized test packets from the spare, feed them through `src/lib/xy-vmc-sales-offline.ts`, and cross-check raw counters after a controlled vend. Confirm little/big endian and money units.
5. Verify totals for at least two days with cash transactions and a refund/failed vend scenario if available. Test power-cycle/reset behavior. Prefer *read only* so it cannot alter machine pricing, payout, inventory, or product delivery.
6. Only after verified readings should Snacky add a separate source type (`xy_vmc_daily_aggregate`), machine-origin timestamps, heartbeat and stale-data safeguards. Keep this separate from `vms_transactions_raw` until transaction-level provenance exists.
7. For 24h zero-sales alerts, collect at least two independent machine observations covering a full local-day window, exclude planned closures/power outages and alert **data unavailable** when the collector goes offline.

## Alternate interim route — authenticated dashboard export

Snacky's existing `vms_transactions_raw` import pipeline can accept vendor transaction reports (with required schema mapping). The official XY web dashboard contains order/export endpoints, but no unauthenticated data access is known. If the merchant's existing dashboard account permits transaction exports, use that feature to **manually** download and import, or arrange an approved scheduled report. Manual exports cannot guarantee a real-time 24-hour no-sales alarm.

## Code in this feasibility PR

`src/lib/xy-vmc-sales-offline.ts`: pure, side-effect-free packet integrity and read-only sales reply parser. Strict framing and XOR validation; raw unverified unsigned 32-bit values exposed as two endianness candidates. No serial-port opening, machine polling, outgoing command, server endpoint, deployment cron, writes to the vending machines or monetary claims.

`scripts/test-xy-vmc-sales-offline.mjs`: documented POLL/ACK fixtures, synthetic daily and selection replies, and rejection of malformed or truncated responses.

**Do not enable field integration until hardware access and data accuracy are demonstrated.**
