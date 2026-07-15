export type VmsReportType = "stock" | "machine_stock_snapshot" | "sales" | "monthly_product_profit" | "monthly_transaction_details" | "vms_order_details_weekly" | "product_list" | "machine_status" | "planogram" | "custom";

export type VmsParsedSheet = {
  name: string;
  rows: string[][];
};

export type VmsParsedFile = {
  fileType: "csv" | "xls" | "xlsx";
  sheets: VmsParsedSheet[];
};

export type VmsSheetRecords = {
  headerRowIndex: number;
  headerConfidence: number;
  headers: string[];
  records: Record<string, string>[];
  samples: Record<string, string>;
  columnSamples: Record<string, string[]>;
};

export type VmsSalesReportPeriod = {
  reportStartDate: string;
  reportEndDate: string;
  salesMonth: string;
  sourceTitle: string;
  sourceRowIndex: number;
};

export const VMS_SALES_DATE_RANGE_ERROR = "Could not find sales report date range in the Excel title. Please check the VMS export format.";

export type VmsFieldDef = {
  field: string;
  label: string;
  required?: boolean;
  requiredGroup?: string;
  aliases: string[];
};

export type VmsMappingDetection = {
  field: string;
  header: string;
  score: number;
  confidence: "high" | "medium" | "low" | "missing";
};

export const vmsReportTypes: { value: VmsReportType; label: string }[] = [
  { value: "machine_stock_snapshot", label: "Machine Stock Snapshot" },
  { value: "stock", label: "Machine Goods / Stock" },
  { value: "vms_order_details_weekly", label: "Detailed Order Details - Recommended" },
  { value: "sales", label: "General / Summary Sales Report" },
  { value: "monthly_product_profit", label: "Monthly Profit Report" },
  { value: "monthly_transaction_details", label: "Monthly Transaction Report" },
  { value: "product_list", label: "Product list" },
  { value: "machine_status", label: "Machine status" },
  { value: "planogram", label: "Planogram / selection management" },
  { value: "custom", label: "Unknown / Custom" },
];

export const vmsExpectedFields: Record<VmsReportType, VmsFieldDef[]> = {
  stock: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "item_id", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜Â¨Ã˜Â§Ã˜Â±Ã™Æ’Ã™Ë†Ã˜Â¯"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜ÂµÃ™â€ Ã™Â", "Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬"] },
    { field: "current_qty", label: "Current quantity", required: true, aliases: ["Stock", "Current Stock", "Inventory", "Qty", "Quantity", "Remaining", "Balance", "current_qty", "stock_qty", "remaining_qty", "on_hand", "available_qty", "Ã˜Â¹Ã˜Â¯Ã˜Â¯", "Ã˜Â§Ã™â€žÃ™Æ’Ã™â€¦Ã™Å Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â®Ã˜Â²Ã™Ë†Ã™â€ "] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã™Ë†Ã™â€šÃ˜Â¹"] },
    { field: "slot_code", label: "Slot code", aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil", "slot_code", "selection_code", "channel_no", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ˜Â®Ã˜Â§Ã™â€ Ã˜Â©", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ˜Â±Ã™Â", "Ã˜Â§Ã™â€žÃ˜Â®Ã˜Â§Ã™â€ Ã˜Â©"] },
    { field: "tray_number", label: "Tray number", aliases: ["Tray Number", "Tray No", "Tray", "Shelf", "tray_number", "tray_no", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ˜Â±Ã™Â"] },
    { field: "capacity", label: "Capacity", aliases: ["Capacity", "Max Stock", "Full Qty", "Par", "capacity", "max_qty", "par_qty", "Ã˜Â§Ã™â€žÃ˜Â³Ã˜Â¹Ã˜Â©"] },
    { field: "empty_status", label: "Empty status", aliases: ["Empty Status", "Empty", "Empty Tray", "Empty Slot", "Out of Stock", "Out Of Stock", "Sold Out", "Status", "empty_status", "tray_status", "out_of_stock", "sold_out"] },
    { field: "updated_at", label: "Updated at", aliases: ["Updated At", "Last Updated", "Date", "Time", "Timestamp", "captured_at", "updated_at", "Ã˜ÂªÃ˜Â§Ã˜Â±Ã™Å Ã˜Â®"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "Retail Price", "selling_price", "sale_price", "Ã˜Â³Ã˜Â¹Ã˜Â± Ã˜Â§Ã™â€žÃ˜Â¨Ã™Å Ã˜Â¹"] },
  ],
  machine_stock_snapshot: [
    { field: "machine_identifier", label: "Machine code", required: true, aliases: ["Machine code", "Machine Code", "machine_code", "Machine ID", "Device ID", "Machine No", "Vending Machine"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine name", "Machine Name", "machine_name", "Device Name"] },
    { field: "point_name", label: "Point name", aliases: ["Point name", "Point Name", "point_name", "Location", "location_name"] },
    { field: "product_identifier", label: "Product Number", requiredGroup: "product", aliases: ["Product Number", "Product number", "product_number", "Product No", "Goods Number", "Commodity Number", "Product Code", "vms_product_code"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["product name", "Product name", "Product Name", "vms_product_name", "Goods Name", "Commodity Name"] },
    { field: "product_specification", label: "Product Specification", aliases: ["Product Specification", "Product specification", "product_specification", "Specification", "Spec"] },
    { field: "barcode", label: "Product bar code", aliases: ["Product bar code", "Product Bar Code", "Product barcode", "Product Barcode", "barcode", "bar_code"] },
    { field: "third_party_commodity_number", label: "Third party commodity number", aliases: ["Third party commodity number", "Third Party Commodity Number", "third_party_commodity_number", "Third party commodity no", "Third Party Commodity No"] },
    { field: "product_unit", label: "Product Unit", aliases: ["Product Unit", "Product unit", "product_unit", "Unit"] },
    { field: "production_date", label: "Production date", aliases: ["Production date", "Production Date", "production_date", "Manufacture date"] },
    { field: "warranty_date", label: "Warranty date", aliases: ["Warranty date", "Warranty Date", "warranty_date", "Expiry date", "Expiration date"] },
    { field: "current_qty", label: "Inventory quantity", required: true, aliases: ["Inventory quantity", "Inventory Quantity", "inventory_quantity", "Inventory qty", "Stock", "Current Stock", "current_qty", "stock_qty", "Quantity"] },
    { field: "out_of_stock_qty", label: "Out of stock quantity", aliases: ["Out of stock quantity", "Out Of Stock Quantity", "out_of_stock_quantity", "out_of_stock_qty", "Missing quantity", "Empty quantity"] },
    { field: "capacity", label: "Inventory capacity", aliases: ["Inventory capacity", "Inventory Capacity", "inventory_capacity", "Capacity", "capacity", "Max Stock", "slot_capacity"] },
  ],
  sales: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜Â¨Ã˜Â§Ã˜Â±Ã™Æ’Ã™Ë†Ã˜Â¯"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜ÂµÃ™â€ Ã™Â", "Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬"] },
    { field: "sold_qty", label: "Sold quantity", requiredGroup: "sales_measure", aliases: ["Sold Qty", "Sales Qty", "Quantity Sold", "Vend Count", "Count", "sold_qty", "quantity_sold", "units_sold", "sales_qty", "Ã˜Â§Ã™â€žÃ™Æ’Ã™â€¦Ã™Å Ã˜Â© Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â¨Ã˜Â§Ã˜Â¹Ã˜Â©", "Ã˜Â¹Ã˜Â¯Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â¨Ã™Å Ã˜Â¹Ã˜Â§Ã˜Âª"] },
    { field: "total_sales_amount", label: "Total sales amount", requiredGroup: "sales_measure", aliases: ["Sales Amount", "Revenue", "Amount", "Total Sales", "Turnover", "sales_amount", "total_sales", "revenue_amount", "gross_sales", "Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â¨Ã™Å Ã˜Â¹Ã˜Â§Ã˜Âª", "Ã˜Â§Ã™â€žÃ˜Â¥Ã™Å Ã˜Â±Ã˜Â§Ã˜Â¯", "Ã˜Â§Ã™â€žÃ™â€šÃ™Å Ã™â€¦Ã˜Â©"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã™Ë†Ã™â€šÃ˜Â¹"] },
    { field: "sale_date", label: "Sale date", aliases: ["Date", "Sale Date", "Time", "Transaction Date", "period_end", "sales_date", "business_date", "timestamp", "Ã˜Â§Ã™â€žÃ˜ÂªÃ˜Â§Ã˜Â±Ã™Å Ã˜Â®"] },
    { field: "revenue_amount", label: "Revenue amount", aliases: ["Sales Amount", "Revenue", "Amount", "Total Sales", "Turnover", "sales_amount", "total_sales", "Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â¨Ã™Å Ã˜Â¹Ã˜Â§Ã˜Âª", "Ã˜Â§Ã™â€žÃ˜Â¥Ã™Å Ã˜Â±Ã˜Â§Ã˜Â¯", "Ã˜Â§Ã™â€žÃ™â€šÃ™Å Ã™â€¦Ã˜Â©"] },
    { field: "cost_amount", label: "Cost amount", aliases: ["Cost", "Product Cost", "Total Cost", "cost_amount", "cogs", "Ã˜Â§Ã™â€žÃ˜ÂªÃ™Æ’Ã™â€žÃ™ÂÃ˜Â©"] },
    { field: "profit_amount", label: "Profit amount", aliases: ["Profit", "Gross Profit", "profit_amount", "gross_profit", "Ã˜Â§Ã™â€žÃ˜Â±Ã˜Â¨Ã˜Â­"] },
    { field: "vms_transaction_id", label: "VMS transaction ID", aliases: ["Transaction ID", "Transaction No", "Order ID", "Order No", "Receipt ID", "Receipt No", "Txn ID", "txn_id", "transaction_id", "transaction_no", "order_id", "receipt_id"] },
    { field: "payment_method", label: "Payment method", aliases: ["Payment Method", "Payment", "Tender", "Method", "payment_method"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "selling_price", "sale_price", "Ã˜Â³Ã˜Â¹Ã˜Â± Ã˜Â§Ã™â€žÃ˜Â¨Ã™Å Ã˜Â¹"] },
  ],
  monthly_product_profit: [
    { field: "merchant_id", label: "Merchant ID", aliases: ["Merchant ID", "merchant_id"] },
    { field: "merchant_name", label: "Merchant Name", aliases: ["Merchant Name", "merchant_name"] },
    { field: "machine_identifier", label: "Machine code", aliases: ["Machine code", "Machine Code", "machine_code", "Machine ID", "Machine Id", "machine_id"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine name", "Machine Name", "machine_name", "Device Name"] },
    { field: "product_identifier", label: "Product Number", aliases: ["Product Number", "Product number", "product_number", "Product No", "Product No.", "product_no"] },
    { field: "product_name", label: "product name", aliases: ["product name", "Product name", "Product Name", "product_name", "Commodity Name", "Goods Name"] },
    { field: "commodity_price", label: "Commodity price", aliases: ["Commodity price", "Commodity Price", "commodity_price", "Commodity unit price", "Unit price", "Unit Price"] },
    { field: "transaction_count", label: "Number of transaction", aliases: ["Number of transaction", "Number of transactions", "Transaction Count", "transaction_count", "number_of_transaction", "number_of_transactions"] },
    { field: "transaction_amount", label: "Transaction amount", aliases: ["Transaction amount", "Transaction Amount", "transaction_amount", "Amount", "Sales Amount", "Revenue"] },
    { field: "refund_count", label: "Refund count", aliases: ["Refund count", "Refund Count", "The refund count", "refund_count"] },
    { field: "refund_amount", label: "Refund amount", aliases: ["Refund amount", "Refund Amount", "refund_amount"] },
    { field: "total_transaction_count", label: "Total Transaction", aliases: ["Total Transaction", "Total Transaction Quantity", "Total transactions", "total_transaction_count"] },
    { field: "total_transaction_amount", label: "Total Transaction amount", aliases: ["Total Transaction amount", "Total Transaction Amount", "total_transaction_amount"] },
    { field: "cost_price", label: "Cost Price", aliases: ["Cost Price", "cost_price", "Cost price"] },
    { field: "cost_amount", label: "Cost Amount", aliases: ["Cost Amount", "cost_amount", "Cost amount"] },
    { field: "profit_amount", label: "Profits", aliases: ["Profits", "Profit", "profit_amount", "Gross Profit"] },
  ],
  monthly_transaction_details: [
    { field: "merchant_id", label: "Merchant ID", aliases: ["Merchant ID", "merchant_id"] },
    { field: "merchant_name", label: "Merchant name", aliases: ["Merchant Name", "merchant_name"] },
    { field: "machine_identifier", label: "Machine code", required: true, aliases: ["Machine code", "Machine Code", "machine_code", "Machine ID", "Machine Id", "machine_id", "Terminal ID", "terminal_id"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine name", "Machine Name", "machine_name", "Device Name", "Location"] },
    { field: "serial_number", label: "Serial number", aliases: ["Serial number", "Serial Number", "serial_number", "Serial No", "Serial No.", "Machine serial number"] },
    { field: "product_identifier", label: "Product number", requiredGroup: "product", aliases: ["Product Number", "Product number", "product_number", "Product No", "Product No.", "Goods Number", "Commodity Number", "product_identifier"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["product name", "Product name", "Product Name", "vms_product_name", "Commodity Name", "Goods Name", "product"] },
    { field: "cargo_lane_number", label: "Cargo lane", aliases: ["Cargo lane", "Cargo Lane", "cargo_lane", "Cargo Lane Number", "cargo_lane_number", "Lane", "Selection", "slot_code"] },
    { field: "sales_price", label: "Sales price", aliases: ["Sales price", "Sales Price", "sales_price", "Selling Price", "selling_price", "Price", "price", "Unit Price", "unit_price"] },
    { field: "mode_of_payment", label: "Mode of payment", aliases: ["Mode of payment", "Mode of Payment", "mode_of_payment", "Payment method", "Payment Method", "payment_method", "payment_type", "tender"] },
    { field: "payment_amount", label: "Payment amount", required: true, aliases: ["Payment amount", "Payment Amount", "payment_amount", "Paid amount", "Amount paid", "Amount", "amount"] },
    { field: "refund_amount", label: "Refund amount", aliases: ["Refund amount", "Refund Amount", "refund_amount"] },
    { field: "discount_price", label: "Discount price", aliases: ["Discount price", "Discount Price", "discount_price", "Discounted price", "Discounted Price", "discounted_price"] },
    { field: "payment_time", label: "Time of payment", requiredGroup: "transaction_time", aliases: ["Time of payment", "Payment time", "Payment Time", "time_of_payment", "payment_time", "Paid time", "Paid Time"] },
    { field: "refund_time", label: "Refund time", aliases: ["Refund time", "Refund Time", "refund_time"] },
    { field: "third_party_order_no", label: "Third Party Order No.", aliases: ["Third Party Order No.", "Third Party Order No", "Third party order no", "third_party_order_no", "Third Party Order Number"] },
    { field: "third_party_transaction", label: "Third Party Transaction", aliases: ["Third Party Transaction", "Third Party Transaction No.", "Third Party Transaction No", "third_party_transaction", "third_party_transaction_number", "Third Party Transaction Number"] },
    { field: "logic_card_number", label: "Logic card number", aliases: ["Logic card number", "Logic Card Number", "logic_card_number", "Card number", "Card Number", "card_number"] },
    { field: "quantity", label: "Quantity", aliases: ["Quantity", "Qty", "quantity", "Num", "num"] },
    { field: "transaction_status", label: "Transaction status", aliases: ["Transaction status", "Transaction Status", "transaction_status", "Status", "status", "Result", "result", "Payment status", "payment_status"] },
  ],
  vms_order_details_weekly: [
    { field: "merchant_id", label: "Merchant ID", aliases: ["Merchant ID", "merchant_id"] },
    { field: "merchant_name", label: "Merchant name", aliases: ["Merchant Name", "merchant_name"] },
    { field: "machine_identifier", label: "Machine code", required: true, aliases: ["Machine code", "Machine Code", "machine_code", "Machine ID", "Device ID", "terminal_id", "device_id"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine name", "Machine Name", "machine_name", "Device Name", "Location"] },
    { field: "order_number", label: "Order number", aliases: ["Order number", "Order Number", "order_number", "Order No", "Order No.", "order_no"] },
    { field: "cargo_lane_number", label: "Cargo lane number", aliases: ["Cargo Lane Number", "Cargo lane number", "cargo_lane_number", "Lane Number", "lane_number", "Cargo Lane", "cargo_lane", "Slot", "slot_code"] },
    { field: "product_identifier", label: "Product number", requiredGroup: "product", aliases: ["Product Number", "Product number", "product_number", "Product No", "Product No.", "Goods Number", "Commodity Number", "product_identifier"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["product name", "Product name", "Product Name", "vms_product_name", "Commodity Name", "Goods Name", "product"] },
    { field: "commodity_price_1", label: "Commodity price 1", aliases: ["Commodity price (1)", "Commodity Price (1)", "commodity_price_1", "Commodity price 1", "Commodity Price 1"] },
    { field: "commodity_price_2", label: "Commodity price 2", aliases: ["Commodity price (2)", "Commodity Price (2)", "commodity_price_2", "Commodity price 2", "Commodity Price 2"] },
    { field: "discounted_price", label: "Discounted price", aliases: ["Discounted price", "Discounted Price", "discounted_price"] },
    { field: "delivery_time", label: "Delivery time", requiredGroup: "transaction_time", aliases: ["Delivery time", "Delivery Time", "delivery_time", "Shipment time", "Vend time"] },
    { field: "shipping_status", label: "Shipping status", required: true, aliases: ["Shipping status", "Shipping Status", "shipping_status", "Shipment status", "Vend status"] },
    { field: "purchaser", label: "Purchaser", aliases: ["Purchaser", "purchaser", "Buyer", "Customer"] },
    { field: "refund_time", label: "Refund time", aliases: ["Refund time", "Refund Time", "refund_time"] },
    { field: "remarks", label: "Remarks", aliases: ["Remarks", "remarks", "Remark", "Notes"] },
    { field: "refund_status", label: "Refund status", aliases: ["Refund status", "Refund Status", "refund_status"] },
    { field: "third_party_transaction_number", label: "Third Party Transaction Number", aliases: ["Third Party Transaction Number", "Third party transaction number", "third_party_transaction_number", "Third Party Transaction No.", "Third Party Transaction No"] },
    { field: "third_party_order_no", label: "Third Party Order No.", aliases: ["Third Party Order No.", "Third Party Order No", "Third party order no", "third_party_order_no", "Third Party Order Number"] },
    { field: "payment_amount", label: "Payment amount", required: true, aliases: ["Payment amount", "Payment Amount", "payment_amount", "Paid amount", "Amount paid"] },
    { field: "payment_time", label: "Time of payment", requiredGroup: "transaction_time", aliases: ["Time of payment", "Payment time", "Payment Time", "time_of_payment", "payment_time", "Paid time"] },
    { field: "quantity", label: "Num", aliases: ["Num", "num", "Quantity", "Qty", "quantity"] },
  ],
  product_list: [
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Goods Code", "Item Code", "SKU", "Barcode", "VMS Product ID", "VMS Product Code", "vms_product_id", "product_id", "product_code", "goods_code", "item_code", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜Â¨Ã˜Â§Ã˜Â±Ã™Æ’Ã™Ë†Ã˜Â¯"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜ÂµÃ™â€ Ã™Â"] },
    { field: "vms_product_id", label: "VMS product ID", requiredGroup: "product", aliases: ["VMS Product ID", "VMS ID", "Product ID", "Goods ID", "vms_product_id", "product_id", "goods_id"] },
    { field: "product_code", label: "Product code", requiredGroup: "product", aliases: ["Product Code", "Goods Code", "Item Code", "SKU", "product_code", "goods_code", "item_code"] },
    { field: "barcode", label: "Barcode", aliases: ["Barcode", "EAN", "UPC", "bar_code", "Ã˜Â§Ã™â€žÃ˜Â¨Ã˜Â§Ã˜Â±Ã™Æ’Ã™Ë†Ã˜Â¯"] },
    { field: "category", label: "Category", aliases: ["Category", "Type", "Group", "Product Type", "category", "Ã˜Â§Ã™â€žÃ˜ÂªÃ˜ÂµÃ™â€ Ã™Å Ã™Â", "Ã˜Â§Ã™â€žÃ™â€ Ã™Ë†Ã˜Â¹"] },
    { field: "brand", label: "Brand", aliases: ["Brand", "Manufacturer", "brand", "manufacturer", "Ã˜Â§Ã™â€žÃ˜Â¹Ã™â€žÃ˜Â§Ã™â€¦Ã˜Â© Ã˜Â§Ã™â€žÃ˜ÂªÃ˜Â¬Ã˜Â§Ã˜Â±Ã™Å Ã˜Â©"] },
    { field: "cost_price", label: "Cost price", aliases: ["Cost", "Cost Price", "Product Cost", "Purchase Price", "cost_price", "unit_cost", "Ã˜Â§Ã™â€žÃ˜ÂªÃ™Æ’Ã™â€žÃ™ÂÃ˜Â©", "Ã˜Â³Ã˜Â¹Ã˜Â± Ã˜Â§Ã™â€žÃ˜Â´Ã˜Â±Ã˜Â§Ã˜Â¡"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Sale Price", "Price", "Retail Price", "Unit Price", "selling_price", "sale_price", "Ã˜Â§Ã™â€žÃ˜Â³Ã˜Â¹Ã˜Â±", "Ã˜Â³Ã˜Â¹Ã˜Â± Ã˜Â§Ã™â€žÃ˜Â¨Ã™Å Ã˜Â¹"] },
    { field: "active_status", label: "Active status", aliases: ["Status", "Active", "Enabled", "Active Status", "active_status", "Ã˜Â§Ã™â€žÃ˜Â­Ã˜Â§Ã™â€žÃ˜Â©"] },
    { field: "image_url", label: "Image URL", aliases: ["Image URL", "Image", "Photo", "Picture", "image_url", "image"] },
  ],
  machine_status: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã™Ë†Ã™â€šÃ˜Â¹"] },
    { field: "online_status", label: "Online status", aliases: ["Online Status", "Online", "Offline", "Status", "Connection Status", "Machine Status", "online_status", "network_status"] },
    { field: "temperature", label: "Temperature", aliases: ["Temperature", "Temp", "Cabinet Temperature", "temperature", "temperature_c"] },
    { field: "banknote_balance", label: "Banknote balance", aliases: ["Banknote Balance", "Banknote", "Cash Box", "banknote_balance"] },
    { field: "cash_balance", label: "Cash balance", aliases: ["Cash Balance", "Cash In Machine", "Cash Amount", "cash_balance", "cash_amount"] },
    { field: "last_online_at", label: "Last online at", aliases: ["Last Online", "Last Online At", "Last Updated", "Updated At", "last_online_at", "updated_at"] },
    { field: "error_status", label: "Error status", aliases: ["Error", "Error Status", "Fault", "Alarm", "error_status"] },
  ],
  planogram: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©"] },
    { field: "slot_code", label: "Slot code", required: true, aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil", "slot_code", "selection_code", "channel_no", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ˜Â®Ã˜Â§Ã™â€ Ã˜Â©", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ˜Â±Ã™Â", "Ã˜Â§Ã™â€žÃ˜Â®Ã˜Â§Ã™â€ Ã˜Â©"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "Ã™Æ’Ã™Ë†Ã˜Â¯ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â±Ã™â€šÃ™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜Â¨Ã˜Â§Ã˜Â±Ã™Æ’Ã™Ë†Ã˜Â¯"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬", "Ã˜Â§Ã™â€žÃ˜ÂµÃ™â€ Ã™Â", "Ã˜Â§Ã™â€žÃ™â€¦Ã™â€ Ã˜ÂªÃ˜Â¬"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "Ã˜Â§Ã˜Â³Ã™â€¦ Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â§Ã™Æ’Ã™Å Ã™â€ Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã™Ë†Ã™â€šÃ˜Â¹"] },
    { field: "capacity", label: "Capacity", aliases: ["Capacity", "Max Stock", "Full Qty", "Par", "capacity", "max_qty", "par_qty", "Ã˜Â§Ã™â€žÃ˜Â³Ã˜Â¹Ã˜Â©"] },
    { field: "current_qty", label: "Current quantity", aliases: ["Stock", "Current Stock", "Inventory", "Qty", "Quantity", "Remaining", "Balance", "current_qty", "stock_qty", "Ã˜Â§Ã™â€žÃ™Æ’Ã™â€¦Ã™Å Ã˜Â©", "Ã˜Â§Ã™â€žÃ™â€¦Ã˜Â®Ã˜Â²Ã™Ë†Ã™â€ "] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "selling_price", "sale_price", "Ã˜Â³Ã˜Â¹Ã˜Â± Ã˜Â§Ã™â€žÃ˜Â¨Ã™Å Ã˜Â¹"] },
  ],
  custom: [
    { field: "machine_identifier", label: "Machine identifier", aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine"] },
    { field: "product_identifier", label: "Product identifier", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode"] },
    { field: "product_name", label: "Product name", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name"] },
    { field: "slot_code", label: "Slot / tray / selection", aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil"] },
    { field: "quantity", label: "Quantity", aliases: ["Quantity", "Qty", "Stock", "Sold Qty", "Count"] },
    { field: "amount", label: "Amount", aliases: ["Amount", "Sales Amount", "Total Sales", "Revenue", "Price"] },
    { field: "date", label: "Date / timestamp", aliases: ["Date", "Time", "Timestamp", "Sale Date", "Updated At"] },
  ],
};

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(current.trim());
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function normalizeHeader(header: string) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s\-./()]+/g, "_")
    .replace(/[^a-z0-9_\u0600-\u06ff\u4e00-\u9fff]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function cleanRows(rows: unknown[][]) {
  return rows
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some(Boolean));
}

function spreadsheetColumnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function uniqueHeaders(row: string[]) {
  const bases = row.map((header, index) => header.trim() || `Column ${spreadsheetColumnName(index)}`);
  const totals = new Map<string, number>();
  bases.forEach((base) => totals.set(base, (totals.get(base) ?? 0) + 1));

  const seen = new Map<string, number>();
  return bases.map((base) => {
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return (totals.get(base) ?? 0) > 1 ? `${base} (${count})` : base;
  });
}

function splitTokens(value: string) {
  return normalizeHeader(value).split("_").filter((token) => token.length > 1);
}

function compact(value: string) {
  return normalizeHeader(value).replace(/_/g, "");
}

function extraAliasesForField(field: string) {
  const aliases: Record<string, string[]> = {
    machine_identifier: ["Machine code", "Machine Code", "Machine number", "Machine Number"],
    machine_name: ["Machine name", "Machine Name"],
    product_identifier: ["Product Number", "Product No", "Product number", "Commodity Number", "Commodity No", "Goods Number", "product_number"],
    product_name: ["product name", "Product name", "Commodity Name", "commodity_name"],
    sold_qty: ["Number of transaction", "Number of transactions", "Transaction Count", "Transactions", "transaction_count", "number_of_transaction"],
    total_sales_amount: ["Transaction amount", "Transaction Amount", "Total Sales LYD", "total_sales_lyd", "transaction_amount"],
    selling_price: ["Commodity price", "Commodity Price", "Commodity unit price", "commodity_price"],
    merchant_id: ["Merchant ID", "merchant_id"],
    merchant_name: ["Merchant Name", "merchant_name"],
    transaction_count: ["Number of transaction", "Number of transactions", "Transaction Count", "transaction_count", "number_of_transaction"],
    transaction_amount: ["Transaction amount", "Transaction Amount", "transaction_amount", "Sales Amount", "Revenue"],
    refund_count: ["Refund count", "Refund Count", "The refund count", "refund_count"],
    refund_amount: ["Refund amount", "Refund Amount", "refund_amount"],
    total_transaction_count: ["Total Transaction", "Total Transaction Quantity", "Total transactions", "total_transaction_count"],
    total_transaction_amount: ["Total Transaction amount", "Total Transaction Amount", "total_transaction_amount"],
    cost_price: ["Cost Price", "cost_price"],
    cost_amount: ["Cost Amount", "cost_amount"],
    profit_amount: ["Profits", "Profit", "profit_amount", "Gross Profit"],
    payment_amount: ["Payment amount", "Payment Amount", "Amount paid"],
    payment_time: ["Time of payment", "Payment time", "Payment Time"],
    delivery_time: ["Delivery time", "Delivery Time"],
    shipping_status: ["Shipping status", "Shipping Status"],
  };
  return aliases[field] ?? [];
}

function looksNumeric(value: string) {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
  return cleaned !== "" && Number.isFinite(Number(cleaned));
}

function looksDate(value: string) {
  if (!value.trim()) return false;
  return !Number.isNaN(new Date(value).getTime()) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value.trim()) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(value.trim());
}

function dateOnly(year: string, month: string, day: string) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthStartFromDateOnly(value: string) {
  const [year, month] = value.split("-");
  return `${year}-${month}-01`;
}

export function parseSalesReportPeriodFromText(text: string, sourceRowIndex = 0): VmsSalesReportPeriod | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const datePattern = String.raw`(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})`;
  const rangePattern = new RegExp(`${datePattern}\\s*(?:/|~|\\u2013|\\u2014|-|\\bto\\b)\\s*${datePattern}`, "i");
  const match = raw.match(rangePattern);
  if (!match) return null;

  const reportStartDate = dateOnly(match[1], match[2], match[3]);
  const reportEndDate = dateOnly(match[4], match[5], match[6]);
  if (!reportStartDate || !reportEndDate || reportStartDate > reportEndDate) return null;

  return {
    reportStartDate,
    reportEndDate,
    salesMonth: monthStartFromDateOnly(reportStartDate),
    sourceTitle: raw,
    sourceRowIndex,
  };
}

export function findSalesReportPeriod(rows: unknown[][], headerRowIndex?: number): VmsSalesReportPeriod | null {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) return null;

  const headerIndex = Math.max(0, Math.min(headerRowIndex ?? detectHeaderRowIndex(nonEmptyRows, "sales"), nonEmptyRows.length - 1));
  const metadataRows = nonEmptyRows.slice(0, headerIndex);
  for (const [index, row] of metadataRows.entries()) {
    const period = parseSalesReportPeriodFromText(row.filter(Boolean).join(" "), index);
    if (period) return period;
  }

  return null;
}

function fieldExpectsNumber(field: string) {
  return /(qty|quantity|amount|price|cost|profit|capacity|temperature|cash|trays|min|par|sold|count|transaction|refund)/.test(field);
}

function fieldExpectsDate(field: string) {
  return /(date|time|period|captured|updated)/.test(field);
}

function scoreHeaderForField(header: string, field: VmsFieldDef, sampleValues: string[] = []) {
  const headerNorm = normalizeHeader(header);
  if (!headerNorm) return 0;

  const headerCompact = compact(header);
  const headerTokens = splitTokens(header);
  const aliases = [field.field, field.label, ...field.aliases, ...extraAliasesForField(field.field)];
  let score = 0;

  for (const alias of aliases) {
    const aliasNorm = normalizeHeader(alias);
    if (!aliasNorm) continue;
    const aliasCompact = compact(alias);
    const aliasTokens = splitTokens(alias);

    if (headerNorm === aliasNorm) score = Math.max(score, 100);
    else if (headerCompact === aliasCompact) score = Math.max(score, 96);
    else if (aliasCompact.length >= 4 && headerCompact.includes(aliasCompact)) score = Math.max(score, 86);
    else if (headerCompact.length >= 4 && aliasCompact.includes(headerCompact)) score = Math.max(score, 68);

    if (aliasTokens.length && headerTokens.length) {
      const overlap = aliasTokens.filter((token) => headerTokens.includes(token)).length;
      if (overlap) {
        const coverage = overlap / Math.max(aliasTokens.length, headerTokens.length);
        score = Math.max(score, 42 + Math.round(coverage * 38));
      }
    }
  }

  const nonEmptySamples = sampleValues.filter(Boolean).slice(0, 6);
  if (nonEmptySamples.length) {
    const numericHits = nonEmptySamples.filter(looksNumeric).length;
    const dateHits = nonEmptySamples.filter(looksDate).length;
    if (fieldExpectsNumber(field.field)) score += numericHits >= Math.ceil(nonEmptySamples.length / 2) ? 8 : -8;
    if (fieldExpectsDate(field.field)) score += dateHits >= Math.ceil(nonEmptySamples.length / 2) ? 8 : -8;
  }

  return Math.max(0, Math.min(100, score));
}

function headerRowScore(row: string[], reportType?: VmsReportType) {
  const fields = reportType ? vmsExpectedFields[reportType] : Object.values(vmsExpectedFields).flat();
  let score = 0;
  let textCells = 0;
  let numericCells = 0;

  row.forEach((cell) => {
    if (!cell.trim()) return;
    if (looksNumeric(cell) || looksDate(cell)) numericCells += 1;
    else textCells += 1;
    score += Math.max(...fields.map((field) => scoreHeaderForField(cell, field)), 0) / 12;
  });

  return score + textCells * 2 - numericCells * 1.5;
}

function headerRowStats(row: string[], reportType?: VmsReportType) {
  const fields = reportType ? vmsExpectedFields[reportType] : Object.values(vmsExpectedFields).flat();
  const bestScores = new Map<string, number>();
  let textCells = 0;
  let numericCells = 0;

  row.forEach((cell) => {
    const value = cell.trim();
    if (!value) return;
    if (looksNumeric(value) || looksDate(value)) numericCells += 1;
    else textCells += 1;

    for (const field of fields) {
      const score = scoreHeaderForField(value, field);
      if (score > (bestScores.get(field.field) ?? 0)) {
        bestScores.set(field.field, score);
      }
    }
  });

  const scores = [...bestScores.values()];
  const strongMatches = scores.filter((score) => score >= 62).length;
  const exactMatches = scores.filter((score) => score >= 90).length;
  const totalScore = scores.reduce((sum, score) => sum + score, 0) + textCells * 2 - numericCells * 1.5;

  return { totalScore, strongMatches, exactMatches, textCells, numericCells };
}

export function detectHeaderRowIndex(rows: unknown[][], reportType?: VmsReportType) {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) return 0;

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestStats = { exactMatches: -1, strongMatches: -1, totalScore: Number.NEGATIVE_INFINITY, textCells: -1, numericCells: Number.POSITIVE_INFINITY };
  nonEmptyRows.slice(0, 25).forEach((row, index) => {
    const score = headerRowScore(row, reportType);
    const stats = headerRowStats(row, reportType);
    const better =
      stats.exactMatches > bestStats.exactMatches ||
      (stats.exactMatches === bestStats.exactMatches && stats.strongMatches > bestStats.strongMatches) ||
      (stats.exactMatches === bestStats.exactMatches && stats.strongMatches === bestStats.strongMatches && stats.totalScore > bestStats.totalScore) ||
      (stats.exactMatches === bestStats.exactMatches && stats.strongMatches === bestStats.strongMatches && stats.totalScore === bestStats.totalScore && stats.textCells > bestStats.textCells) ||
      (stats.exactMatches === bestStats.exactMatches && stats.strongMatches === bestStats.strongMatches && stats.totalScore === bestStats.totalScore && stats.textCells === bestStats.textCells && stats.numericCells < bestStats.numericCells);
    if (better || (bestScore === Number.NEGATIVE_INFINITY && index === 0)) {
      bestIndex = index;
      bestScore = score;
      bestStats = stats;
    }
  });

  return bestIndex;
}

export function sheetRowsToRecords(rows: unknown[][], options: { reportType?: VmsReportType; headerRowIndex?: number } = {}): VmsSheetRecords {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) {
    return { headerRowIndex: 0, headerConfidence: 0, headers: [], records: [], samples: {}, columnSamples: {} };
  }

  const headerRowIndex = Math.max(0, Math.min(options.headerRowIndex ?? detectHeaderRowIndex(nonEmptyRows, options.reportType), nonEmptyRows.length - 1));
  const headers = uniqueHeaders(nonEmptyRows[headerRowIndex]);
  const normalizedHeaders = headers.map(normalizeHeader);
  const samples: Record<string, string> = {};
  const columnSamples: Record<string, string[]> = {};
  const records = nonEmptyRows.slice(headerRowIndex + 1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      const key = normalizedHeaders[index] || normalizeHeader(header);
      record[key] = value;
      if (value) {
        if (!samples[header]) samples[header] = value;
        const current = columnSamples[header] ?? [];
        if (!current.includes(value) && current.length < 3) columnSamples[header] = [...current, value];
      }
    });
    return record;
  }).filter((record) => Object.values(record).some(Boolean));

  return {
    headerRowIndex,
    headerConfidence: Math.max(0, Math.round(headerRowScore(nonEmptyRows[headerRowIndex], options.reportType))),
    headers,
    records,
    samples,
    columnSamples,
  };
}

export function detectVmsReportTypeFromHeaders(headers: string[]): VmsReportType | null {
  const normalized = new Set(headers.map(normalizeHeader).filter(Boolean));
  const has = (aliases: string[]) => aliases.some((alias) => normalized.has(normalizeHeader(alias)));
  const monthlyProfitSignals = [
    has(["Merchant ID", "merchant_id"]),
    has(["Merchant Name", "merchant_name"]),
    has(["Machine code", "Machine Code", "machine_code"]),
    has(["Machine name", "Machine Name", "machine_name"]),
    has(["Product Number", "Product number", "product_number"]),
    has(["product name", "Product name", "Product Name", "product_name"]),
    has(["Commodity price", "Commodity Price", "commodity_price"]),
    has(["Number of transaction", "Number of transactions", "transaction_count", "number_of_transaction"]),
    has(["Transaction amount", "Transaction Amount", "transaction_amount"]),
    has(["Refund count", "Refund Count", "The refund count", "refund_count"]),
    has(["Total Transaction", "Total Transaction Quantity", "Total transactions", "total_transaction_count"]),
    has(["Cost Price", "cost_price"]),
    has(["Cost Amount", "cost_amount"]),
    has(["Profits", "Profit", "profit_amount"]),
  ].filter(Boolean).length;

  if (monthlyProfitSignals >= 7) return "monthly_product_profit";

  const detailedSignals = [
    has(["Order number", "Order Number", "order_number"]),
    has(["Cargo Lane Number", "cargo_lane_number"]),
    has(["Shipping status", "Shipping Status", "shipping_status"]),
    has(["Payment amount", "Payment Amount", "payment_amount"]),
    has(["Time of payment", "Payment time", "time_of_payment", "payment_time"]),
    has(["Num", "num"]),
  ].filter(Boolean).length;

  if (detailedSignals >= 4) return "vms_order_details_weekly";

  const monthlyTransactionSignals = [
    has(["Merchant ID", "merchant_id"]),
    has(["Merchant Name", "merchant_name"]),
    has(["Machine code", "Machine Code", "machine_code"]),
    has(["Machine name", "Machine Name", "machine_name"]),
    has(["Product Number", "Product number", "product_number"]),
    has(["product name", "Product name", "Product Name", "product_name"]),
    has(["Sales price", "Sales Price", "sales_price"]),
    has(["Mode of payment", "Mode of Payment", "mode_of_payment", "payment_method"]),
    has(["Payment amount", "Payment Amount", "payment_amount"]),
    has(["Refund amount", "Refund Amount", "refund_amount"]),
    has(["Time of payment", "Payment time", "time_of_payment", "payment_time"]),
    has(["Third Party Order No.", "Third Party Order No", "third_party_order_no"]),
    has(["Third Party Transaction", "Third Party Transaction No.", "third_party_transaction", "third_party_transaction_number"]),
  ].filter(Boolean).length;

  if (monthlyTransactionSignals >= 7) return "monthly_transaction_details";

  const stockSnapshotSignals = [
    has(["Inventory quantity", "Inventory Quantity", "inventory_quantity"]),
    has(["Out of stock quantity", "Out Of Stock Quantity", "out_of_stock_quantity"]),
    has(["Inventory capacity", "Inventory Capacity", "inventory_capacity"]),
    has(["Machine code", "Machine Code", "machine_code"]),
    has(["Product Number", "Product number", "product_number"]),
    has(["product name", "Product name", "Product Name", "product_name"]),
  ].filter(Boolean).length;

  if (stockSnapshotSignals >= 5) return "machine_stock_snapshot";

  const summarySignals = [
    has(["Machine ID", "Machine Code", "Machine", "machine_identifier", "machine_code"]),
    has(["Product ID", "Product Code", "Product Number", "Goods ID", "product_identifier", "product_number"]),
    has(["Product Name", "Goods Name", "product name", "product_name"]),
    has(["Sold Qty", "Sales Qty", "Quantity Sold", "Number of transaction", "number_of_transaction", "sold_qty"]),
    has(["Sales Amount", "Transaction amount", "Revenue", "Total Sales", "sales_amount", "total_sales_amount"]),
  ].filter(Boolean).length;

  return summarySignals >= 3 ? "sales" : null;
}

export function detectVmsReportTypeFromRows(rows: unknown[][]): VmsReportType | null {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) return null;
  const headerRowIndex = detectHeaderRowIndex(nonEmptyRows);
  const metadataRows = nonEmptyRows.slice(0, headerRowIndex);
  if (metadataRows.some((row) => row.join(" ").toLowerCase().includes("statistical report of transaction details"))) {
    return "monthly_transaction_details";
  }
  if (metadataRows.some((row) => row.join(" ").toLowerCase().includes("statistical statement of commodity profit"))) {
    return "monthly_product_profit";
  }
  const headers = uniqueHeaders(nonEmptyRows[headerRowIndex] ?? []);
  return detectVmsReportTypeFromHeaders(headers);
}

export async function parseVmsUpload(file: File): Promise<VmsParsedFile> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "csv") {
    return { fileType: "csv", sheets: [{ name: "CSV", rows: parseCsvRows(await file.text()) }] };
  }

  if (extension === "xls" || extension === "xlsx") {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer", cellDates: true });
      return {
        fileType: extension,
        sheets: workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" }) : [];
          return { name, rows: cleanRows(rows) };
        }).filter((sheet) => sheet.rows.length),
      };
    } catch (error) {
      console.error("[vms-parser] Excel parse failed", {
        fileName: file.name,
        fileType: extension,
        fileSize: file.size,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("This VMS file format could not be read. Please upload .xls, .xlsx, or .csv exported from VMS.");
    }
  }

  throw new Error("Upload a .xlsx, .xls, or .csv file.");
}

export function detectColumnMappingDetails(headers: string[], reportType: VmsReportType, samples: Record<string, string[]> = {}) {
  const usedHeaders = new Set<string>();
  const mapping: Record<string, string> = {};
  const details: VmsMappingDetection[] = [];

  for (const field of vmsExpectedFields[reportType]) {
    const candidates = headers
      .filter((header) => !usedHeaders.has(header))
      .map((header) => ({
        header,
        score: scoreHeaderForField(header, field, samples[header] ?? []),
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const minScore = field.required || field.requiredGroup ? 48 : 55;
    const header = best && best.score >= minScore ? best.header : "";
    if (header) usedHeaders.add(header);
    mapping[field.field] = header;
    details.push({
      field: field.field,
      header,
      score: header ? best.score : 0,
      confidence: !header ? "missing" : best.score >= 84 ? "high" : best.score >= 62 ? "medium" : "low",
    });
  }

  return { mapping, details };
}

export function detectColumnMapping(headers: string[], reportType: VmsReportType, samples: Record<string, string[]> = {}) {
  return detectColumnMappingDetails(headers, reportType, samples).mapping;
}

export function applyColumnMapping(records: Record<string, string>[], mapping: Record<string, string>) {
  return records.map((record) => {
    const mapped = { ...record };
    for (const [field, header] of Object.entries(mapping)) {
      if (!header) continue;
      mapped[field] = record[normalizeHeader(header)] ?? "";
    }
    return mapped;
  });
}

export function parseReportType(value: FormDataEntryValue | string | null | undefined): VmsReportType | null {
  const raw = String(value ?? "");
  return vmsReportTypes.some((type) => type.value === raw) ? (raw as VmsReportType) : null;
}

export function requiredMissing(mapping: Record<string, string>, reportType: VmsReportType) {
  const fields = vmsExpectedFields[reportType];
  const missing = fields.filter((field) => field.required && !mapping[field.field]).map((field) => field.label);
  const groups = new Map<string, VmsFieldDef[]>();

  fields.forEach((field) => {
    if (!field.requiredGroup) return;
    groups.set(field.requiredGroup, [...(groups.get(field.requiredGroup) ?? []), field]);
  });

  groups.forEach((groupFields) => {
    if (!groupFields.some((field) => mapping[field.field])) {
      missing.push(groupFields.map((field) => field.label).join(" OR "));
    }
  });

  return missing;
}
