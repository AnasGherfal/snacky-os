import {buyingOutcomeLabels,type BuyingItem} from '@/lib/buying-lists';
import styles from './BuyingLists.module.css';
export function BuyingListTable({items,ar,print=false}:{items:BuyingItem[];ar:boolean;print?:boolean}){
 return <table className={styles.table}>{print?<colgroup>{[36,9,11,9,15,20].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup>:null}<thead><tr>{(ar?['المنتج / المورد المقترح','الصناديق','وحدة/صندوق','الوحدات','تكلفة تقديرية','النتيجة']:['Product / suggested supplier','Boxes','Units/box','Units','Estimated cost','Result']).map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>
 {items.map(i=><tr key={i.product_id}><td><strong>{i.name}</strong>{i.supplier?<small>{i.supplier}</small>:null}{i.note?<small>{i.note}</small>:null}</td><td><b>{i.planned_boxes}</b></td><td>{i.units_per_box}</td><td>{i.planned_boxes*i.units_per_box}</td><td>{i.unit_cost==null?'—':(Number(i.unit_cost)*i.planned_boxes*i.units_per_box).toFixed(2)}<small>LYD</small></td><td>{print&&i.outcome==='pending'?'☐ __________':buyingOutcomeLabels[i.outcome][ar?1:0]}{i.bought_boxes>0?<small>{i.bought_boxes} {ar?'صندوق':'boxes'}</small>:null}</td></tr>)}
 </tbody></table>;
}
