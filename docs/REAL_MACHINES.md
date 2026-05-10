# Real Snacky Machines — Starter Filled Version

This file is intentionally **not empty** so Codex can build seed data, forms, and workflows around a realistic Snacky structure.

Important: replace the placeholder `VMS Machine ID` values with the exact IDs from your VMS export before relying on live imports.

Source assumptions used:

- Snacky currently operates a small active fleet and is preparing for growth.
- Project overview says there are active machines, incoming lift machines, mall/hospital locations, school preparation, rent range of 350–900 LYD, school fixed-rent target of 500–700 LYD, target NSM of at least 2,800 LYD per machine, and uptime target of at least 98%.
- The owner mentioned operating around 8 machines; this file therefore creates 8 usable machine rows: 4 active, 3 incoming/assigned, and 1 growth/standby row.

## Machine list

| Internal Code | VMS Machine ID | Name | Type | Location | Location Type | Rent LYD | Status | Target NSM LYD | Target Uptime % | Notes |
|---|---|---|---|---|---|---:|---|---:|---:|---|
| SNK-001 | VMS_MACHINE_ID_TBD_001 | Hospital Machine 01 | Lift | Hospital Active Location | Hospital | 900 | Active | 2800 | 98 | Good candidate for professional branding and higher reliability standards. Replace VMS ID. |
| SNK-002 | VMS_MACHINE_ID_TBD_002 | Mall Machine 01 | Non-lift | Mall Active Location 01 | Mall | 900 | Active | 2800 | 98 | Possible underperforming mall machine / relocation candidate to school. Replace VMS ID. |
| SNK-003 | VMS_MACHINE_ID_TBD_003 | Mall Machine 02 | Lift | Mall Active Location 02 | Mall | 700 | Active | 2800 | 98 | Active machine. Replace VMS ID and exact rent. |
| SNK-004 | VMS_MACHINE_ID_TBD_004 | Mixed Location Machine 01 | Non-lift | Mixed Active Location | Mall/Office | 350 | Active | 2800 | 98 | Active machine. Replace location, VMS ID, and rent. |
| SNK-005 | VMS_MACHINE_ID_TBD_005 | School Machine 01 | Lift | School Target Location 01 | School | 650 | Planned / Incoming | 2800 | 98 | Incoming/assigned lift machine for school or hospital launch. School rent estimate uses 500–700 LYD target. |
| SNK-006 | VMS_MACHINE_ID_TBD_006 | School Machine 02 | Lift | School Target Location 02 | School | 650 | Planned / Incoming | 2800 | 98 | Incoming/assigned lift machine. Replace with real school after contract. |
| SNK-007 | VMS_MACHINE_ID_TBD_007 | Hospital/University Machine 02 | Lift | Hospital or University Target Location | Hospital/University | 700 | Planned / Incoming | 2800 | 98 | Incoming/assigned lift machine. Replace exact location. |
| SNK-008 | VMS_MACHINE_ID_TBD_008 | Growth Machine 01 | Lift | Future High-Traffic Location | School/Hospital/University | 650 | Standby / Planning | 2800 | 98 | Placeholder for the owner’s current 8-machine planning structure. Replace or delete if not needed. |

## Location records Codex should seed from this file

| Location Name | Type | Rent LYD | Status | Notes |
|---|---|---:|---|---|
| Hospital Active Location | Hospital | 900 | Active | Replace with real hospital name and contact. |
| Mall Active Location 01 | Mall | 900 | Active | Possible relocation candidate if underperforming. |
| Mall Active Location 02 | Mall | 700 | Active | Replace with real mall name. |
| Mixed Active Location | Mall/Office | 350 | Active | Replace with exact location. |
| School Target Location 01 | School | 650 | Pipeline | Fixed rent target 500–700 LYD. |
| School Target Location 02 | School | 650 | Pipeline | Fixed rent target 500–700 LYD. |
| Hospital or University Target Location | Hospital/University | 700 | Pipeline | Replace when signed. |
| Future High-Traffic Location | School/Hospital/University | 650 | Pipeline | Placeholder growth location. |

## Replacement checklist

Before production VMS import, update:

- exact VMS machine IDs
- exact location names
- exact rent values
- exact machine type if any row is wrong
- exact status: Active, Planned, Incoming, Standby, Relocated, Retired
- serial numbers if available
- installed dates if available
