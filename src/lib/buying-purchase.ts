export type BuyingPurchaseItem={
 product_id:string;
 name:string;
 bought_boxes:number;
 units_per_box:number;
 reference_unit_cost_lyd:number|null;
 reference_purchased_on:string|null;
 note:string;
};
export type BuyingLinkedPurchase={
 purchase_id:string|null;
 status:string|null;
 total_amount:number|null;
 received_at:string|null;
 receiving_storage_location_id:string|null;
 receipt_number:string|null;
 voided_at:string|null;
};
export type BuyingPurchaseGroup={
 supplier_id:string;
 store_name:string;
 store_phone:string|null;
 item_count:number;
 bought_boxes:number;
 items:BuyingPurchaseItem[];
 linked_purchase:BuyingLinkedPurchase;
};
export type BuyingPurchaseWorkspace={
 list_id:string;
 revision:number;
 status:'open'|'completed'|'cancelled';
 assigned_to:string;
 can_record:boolean;
 groups:BuyingPurchaseGroup[];
};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buyingPurchaseSource(listId:string,supplierId:string){
 if(!uuid.test(listId)||!uuid.test(supplierId))throw Error('invalid');
 return `buying:${listId}:${supplierId}`;
}
export function parseBuyingPurchaseSource(value:unknown):{listId:string;supplierId:string}|null{
 const raw=String(value??'').trim();
 const match=raw.match(/^buying:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
 if(!match||!uuid.test(match[1])||!uuid.test(match[2]))return null;
 return {listId:match[1],supplierId:match[2]};
}
export function buyingPurchaseGroup(workspace:BuyingPurchaseWorkspace|null|undefined,supplierId:string){
 return workspace?.groups.find(group=>group.supplier_id===supplierId)??null;
}
export function buyingPurchaseQuantities(group:BuyingPurchaseGroup){
 return new Map(group.items.map(item=>[item.product_id,item.bought_boxes*item.units_per_box]));
}
