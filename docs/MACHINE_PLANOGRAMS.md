# Machine Planograms — Starter Filled Version

This file defines what each machine should contain by slot.

Codex should use this to seed `machine_slots` and to build refill recommendations.

Important: this is a practical starter layout, not confirmed real Snacky slot data. Replace slot codes, capacities, and product assignments with the real physical layout of each machine.

## General rules for Codex

- `Capacity` = maximum pieces the slot can hold.
- `Min Qty` = refill trigger quantity.
- `Par Qty` = target quantity after refill.
- `Par Qty` should normally equal capacity.
- Refill suggestion = `Par Qty - latest VMS current qty`.
- Critical priority if current qty = 0.
- High priority if current qty <= Min Qty.

---

## SNK-001 — Hospital Machine 01

Hospital planogram should be more professional, reliable, and drink-heavy.

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 3 | 12 |
| A2 | WATER-500 | Water 500ml | 12 | 3 | 12 |
| A3 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A4 | COLA-330 | Cola 330ml | 10 | 3 | 10 |
| B1 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B2 | ORANGE-330 | Orange Soda 330ml | 10 | 3 | 10 |
| B3 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| B4 | CROISSANT | Croissant | 8 | 2 | 8 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-002 — Mall Machine 01

Mall planogram should include more snacks and impulse products. This row is also a relocation candidate if underperforming.

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 3 | 12 |
| A2 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A3 | COLA-330 | Cola 330ml | 10 | 3 | 10 |
| A4 | ENERGY-DRINK | Energy Drink | 8 | 2 | 8 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| B3 | CHIPS-CHEESE | Cheese Chips | 10 | 3 | 10 |
| B4 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-003 — Mall Machine 02

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 3 | 12 |
| A2 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A3 | ORANGE-330 | Orange Soda 330ml | 10 | 3 | 10 |
| A4 | ENERGY-DRINK | Energy Drink | 8 | 2 | 8 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| B3 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| B4 | CROISSANT | Croissant | 8 | 2 | 8 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-004 — Mixed Location Machine 01

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 3 | 12 |
| A2 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A3 | COLA-330 | Cola 330ml | 10 | 3 | 10 |
| A4 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| B3 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| B4 | CROISSANT | Croissant | 8 | 2 | 8 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-005 — School Machine 01

School planogram should be fun, snack-heavy, and refill-sensitive because school traffic can be concentrated around breaks.

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A2 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A3 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A4 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-CHEESE | Cheese Chips | 10 | 3 | 10 |
| B3 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| B4 | CROISSANT | Croissant | 8 | 2 | 8 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-006 — School Machine 02

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A2 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A3 | ORANGE-330 | Orange Soda 330ml | 10 | 3 | 10 |
| A4 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| B3 | CHIPS-CHEESE | Cheese Chips | 10 | 3 | 10 |
| B4 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-007 — Hospital/University Machine 02

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A2 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A3 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A4 | COLA-330 | Cola 330ml | 10 | 3 | 10 |
| B1 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B2 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| B3 | CROISSANT | Croissant | 8 | 2 | 8 |
| B4 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |

---

## SNK-008 — Growth Machine 01

Default high-traffic starter layout. Replace with school, hospital, university, or office layout after the location is confirmed.

| Slot | Product SKU | Product Name | Capacity | Min Qty | Par Qty |
|---|---|---|---:|---:|---:|
| A1 | WATER-500 | Water 500ml | 12 | 4 | 12 |
| A2 | PEPSI-330 | Pepsi 330ml | 10 | 3 | 10 |
| A3 | COLA-330 | Cola 330ml | 10 | 3 | 10 |
| A4 | JUICE-BOX | Juice Box | 10 | 3 | 10 |
| B1 | CHIPS-HOT | Hot Chips | 10 | 3 | 10 |
| B2 | CHIPS-SALT | Salted Chips | 10 | 3 | 10 |
| B3 | CHIPS-CHEESE | Cheese Chips | 10 | 3 | 10 |
| B4 | BISCUIT | Biscuit Pack | 10 | 3 | 10 |
| C1 | CHOC-BAR | Chocolate Bar | 8 | 2 | 8 |
| C2 | SNICKERS | Snickers | 8 | 2 | 8 |
| C3 | KITKAT | KitKat | 8 | 2 | 8 |
| C4 | GUM-MINT | Gum / Mints | 10 | 3 | 10 |
