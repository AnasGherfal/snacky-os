# Current Data Extraction

Sources:
- docs/source-data/Items.xlsx
- docs/source-data/Snacky - Financial Spreadsheet .xlsx
- docs/source-data/Snacky_KPI_Mart.xlsx

## Mappings
- machines.csv: Items/Machines
- products.csv: Items/Items
- storage_inventory.csv: Items/Inventory
- vms_product_mappings.csv: Items/Item_Mapping + Items/VMS_Products_Helper (name_key matching)
- machine_planograms.csv: Snacky_KPI_Mart/VMS_Stock_Raw (best available; no slot codes)
- operators.csv: Items/Operators
- purchases.csv: Items/Purchases + Items/PurchaseLines
- financial_transactions.csv: Financial Spreadsheet/Txn_Control
- kpi_machine_month.csv: KPI_Mart/LS_Machine_Month
- kpi_product_month.csv: KPI_Mart/LS_Product_Month
- kpi_finance_month.csv: KPI_Mart/LS_Finance_Month

## Assumptions
- Excel serial dates converted to UTC date/time strings.
- Machine IDs and phone values stored in scientific notation were normalized to integer strings.
- `sku` in products.csv uses Item ID when present; no generated SKU rows were needed because all exported products have Item ID.
- `TO_CONFIRM` is used only where source sheets had missing required values.

## Fields requiring confirmation
- machine_planograms.csv: slot_code, par_level, min_level.
- Some inventory rows missing location/reason/machine/refill linkage.
- Some purchases lines missing boxes_qty/received_units/pack_size_used.
- Some transaction rows missing bucket metadata.
