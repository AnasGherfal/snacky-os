import {
  createVmsOrderDetailsDuplicateHash,
  orderDetailsAliases,
  orderDetailsBusinessDate,
  orderDetailsDate,
  orderDetailsNumber,
  orderDetailsPaymentAmount,
  orderDetailsQuantity,
  orderDetailsTransactionStatus,
  orderDetailsValue,
} from './vms-order-details';

/** Weekly sales are transaction evidence, never an instruction to change a machine layout.
 * Reuse the established weekly interpretation and deduplication rules unchanged.
 */
export function weeklyImportRow(input: {
  row: Record<string, string>;
  originalRow: Record<string, string>;
  batchId: string;
  rowNumber: number;
  machineId: string | null;
  productId: string | null;
}) {
  const { row } = input;
  const value = (field: keyof typeof orderDetailsAliases) =>
    orderDetailsValue(row, orderDetailsAliases[field]) || null;
  const number = (field: keyof typeof orderDetailsAliases) =>
    orderDetailsNumber(value(field) ?? '');
  const date = (field: keyof typeof orderDetailsAliases) =>
    orderDetailsDate(value(field) ?? '')?.toISOString() ?? null;
  return {
    import_batch_id: input.batchId,
    row_number: input.rowNumber,
    merchant_id: value('merchantId'),
    merchant_name: value('merchantName'),
    machine_code: value('machineCode'),
    machine_name: value('machineName'),
    order_number: value('orderNumber'),
    cargo_lane_number: value('cargoLaneNumber'),
    product_number: value('productNumber'),
    vms_product_name: value('productName'),
    commodity_price_1: number('commodityPrice1'),
    commodity_price_2: number('commodityPrice2'),
    discounted_price: number('discountedPrice'),
    delivery_time: date('deliveryTime'),
    shipping_status: value('shippingStatus'),
    purchaser: value('purchaser'),
    refund_time: date('refundTime'),
    remarks: value('remarks'),
    refund_status: value('refundStatus'),
    third_party_transaction_number: value('thirdPartyTransactionNumber'),
    third_party_order_no: value('thirdPartyOrderNo'),
    payment_amount: orderDetailsPaymentAmount(row),
    payment_time: date('paymentTime'),
    business_date: orderDetailsBusinessDate(row),
    quantity: orderDetailsQuantity(row),
    raw_row: input.originalRow,
    normalized_row: row,
    mapped_machine_id: input.machineId,
    mapped_product_id: input.productId,
    transaction_status: orderDetailsTransactionStatus(row),
    duplicate_hash: createVmsOrderDetailsDuplicateHash(row),
  };
}
