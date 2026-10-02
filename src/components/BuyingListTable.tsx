import {buyingOutcomeLabels,type BuyingItem} from '@/lib/buying-lists';
import {buyingStoreGroups,sourcePriceText,type BuyingSources} from '@/lib/buying-sources';
import styles from './BuyingLists.module.css';
export function BuyingListTable({items,ar,print=false,sources=null}:{items:BuyingItem[];ar:boolean;print?:boolean;sources?:BuyingSources|null}){
 const hasSources=Boolean(sources?.sources.length),byProduct=new Map(sources?.sources.map(s=>[s.product_id,s])??[]);
 return <table className={styles.table}>{print?<colgroup>{[36,9,11,9,15,20].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup>:null}<thead><tr>{(ar?[hasSources?'المنتج / المورد المطلوب':'المنتج / المورد المقترح','الصناديق','وحدة/صندوق','الوحدات','تكلفة تقديرية','النتيجة']:[hasSources?'Product / required store':'Product / suggested supplier','Boxes','Units/box','Units','Estimated cost','Result']).map(h=><th key={h} scope="col">{h}</th>)}</tr></thead>
 {buyingStoreGroups(items,sources).map(group=><tbody key={group.id}>
 {hasSources?<tr><th colSpan={6} scope="rowgroup">{group.name??(ar?'المورد غير محدد':'Store not assigned')}</th></tr>:null}
 {group.items.map(i=>{const source=byProduct.get(i.product_id);return <tr key={i.product_id}><td><strong>{i.name}</strong>{i.supplier?<small>{i.supplier}</small>:null}
 {source?<><small>{sourcePriceText(source.primary,i.units_per_box,ar)}</small>{source.primary.phone?<small><bdi>{source.primary.phone}</bdi></small>:null}{source.alternative?<small>{ar?'البديل: ':'Alternative: '}{source.alternative.name} · {sourcePriceText(source.alternative,i.units_per_box,ar)}</small>:null}{source.note?<small style={{whiteSpace:'pre-wrap'}}>{source.note}</small>:null}</>:null}
 {i.note?<small>{i.note}</small>:null}</td><td><b>{i.planned_boxes}</b></td><td>{i.units_per_box}</td><td>{i.planned_boxes*i.units_per_box}</td><td>{i.unit_cost==null?'—':(Number(i.unit_cost)*i.planned_boxes*i.units_per_box).toFixed(2)}<small>LYD</small></td><td>{print&&i.outcome==='pending'?'☐ __________':buyingOutcomeLabels[i.outcome][ar?1:0]}{i.bought_boxes>0?<small>{i.bought_boxes} {ar?'صندوق':'boxes'}</small>:null}</td></tr>;})}
 </tbody>)}
 </table>;
}
