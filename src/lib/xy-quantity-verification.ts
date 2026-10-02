import type {MachineQuantityRow} from "@/lib/machine-quantity-confirmation";
import type {XySlotState} from "@/lib/xy-vms-control";

export type XyQuantityMismatch={
 slotCode:string;
 expectedQty:number;
 actualQty:number|null;
 reason:"missing_slot"|"quantity_mismatch"|"generic_slot";
};

function clean(value:unknown){return String(value??"").trim();}

export function verifyMachineQuantityRowsAgainstXy(rows:MachineQuantityRow[],layout:XySlotState[]){
 const bySlot=new Map(layout.map(row=>[clean(row.slotCode),row]));
 const mismatches:XyQuantityMismatch[]=[];
 for(const row of rows){
  const slotCode=clean(row.slotCode);
  if(!slotCode||["VMS","VMS item"].includes(slotCode)){
   mismatches.push({slotCode:slotCode||"VMS",expectedQty:row.finalQty,actualQty:null,reason:"generic_slot"});
   continue;
  }
  const live=bySlot.get(slotCode);
  if(!live){
   mismatches.push({slotCode,expectedQty:row.finalQty,actualQty:null,reason:"missing_slot"});
   continue;
  }
  if(live.currentQty===null||Number(live.currentQty)!==Number(row.finalQty)){
   mismatches.push({slotCode,expectedQty:row.finalQty,actualQty:live.currentQty,reason:"quantity_mismatch"});
  }
 }
 return {verified:rows.length>0&&mismatches.length===0,mismatches};
}
