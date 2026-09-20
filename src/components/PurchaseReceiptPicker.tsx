'use client';
import {useId,useState,type ChangeEvent} from 'react';
import {useLanguage} from '@/components/I18nProvider';
import styles from './PurchaseReceiptPicker.module.css';
/** Native, directly tapped file input. No hidden/programmatic click or nested label. */
export function PurchaseReceiptPicker({onFile,required=false,disabled=false}:{onFile:(file:File|null)=>void;required?:boolean;disabled?:boolean}){
 const id=useId(),{locale}=useLanguage(),ar=locale==='ar';const [error,setError]=useState('');
 function change(event:ChangeEvent<HTMLInputElement>){const file=event.currentTarget.files?.[0]??null;
  if(!file)return; // Cancelling a chooser must not erase an existing preview.
  if(file.size>5*1024*1024||!['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type)){
   event.currentTarget.value='';onFile(null);setError(ar?'اختر صورة PNG أو JPG أو WebP أو ملف PDF لا يتجاوز 5 ميغابايت.':'Choose a PNG, JPG, WebP or PDF up to 5 MB.');return;
  }setError('');onFile(file);
 }
 return <div className={styles.field} data-purchase-receipt-picker>
  <label htmlFor={id}>{ar?'إرفاق الإيصال — صورة أو PDF':'Attach receipt — photo or PDF'}</label>
  <input id={id} name="receipt_file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf" required={required} disabled={disabled} onChange={change} aria-describedby={`${id}-hint${error?` ${id}-error`:''}`} className={styles.input}/>
  <p id={`${id}-hint`}>{ar?'اضغط اختيار ملف، ثم اختر من الصور أو الملفات. اختيار الملف لا يحفظ المشتريات؛ احفظ النموذج بعد المراجعة.':'Tap Choose file, then use Photos or Files. Selecting a file does not save the purchase; review and save the form afterward.'}</p>
  {error?<p id={`${id}-error`} role="alert" className={styles.error}>{error}</p>:null}
 </div>;
}
