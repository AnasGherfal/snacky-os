from pathlib import Path
root=Path(__file__).resolve().parents[1]
for name in ['test-crm-lead-focus.mjs','test-crm-lead-table.mjs']:
 p=root/'scripts'/name;s=p.read_text()
 # Old table/workspace tests keep their real components; only mock the new child at their pre-existing external boundaries.
 for anchor in ["'@/components/CrmLeadQuickLink':", "'@/components/CrmLeadQuickPanel':"]:
  if anchor not in s: raise RuntimeError('Missing existing component test boundary '+name+anchor)
  s=s.replace(anchor,"'@/components/CrmLeadLabels':{CrmLeadLabels:()=>null},"+anchor)
 p.write_text(s)
p=root/'src/components/CrmLeadLabels.tsx';s=p.read_text()
a=" const [editId,setEditId]=useState(''),[name,setName]=useState(''),[color,setColor]=useState<LabelColor>('blue'),[search,setSearch]=useState('');"
b=""" const formKey=key+':definition';
 const [form]=useState(()=>{try{const r=JSON.parse(sessionStorage.getItem(formKey)??'null');if(r&&typeof r.name==='string'&&labelColors.includes(r.color)&&typeof r.id==='string'&&(!r.id||own.some(l=>l.id===r.id)))return r as {id:string;name:string;color:LabelColor};}catch{}return {id:'',name:'',color:'blue' as LabelColor};});
 const [editId,setEditId]=useState(form.id),[name,setName]=useState(form.name),[color,setColor]=useState<LabelColor>(form.color),[search,setSearch]=useState('');
 function remember(id:string,value:string,tone:LabelColor){try{sessionStorage.setItem(formKey,JSON.stringify({id,name:value,color:tone}));}catch{}}
"""
if a not in s:raise RuntimeError('Label form moved')
s=s.replace(a,b)
s=s.replace("setName(l?.name??'');setColor(l?.color??'blue');", "setName(l?.name??'');setColor(l?.color??'blue');remember(e.target.value,l?.name??'',l?.color??'blue');")
s=s.replace('onChange={e=>setName(e.target.value)}','onChange={e=>{setName(e.target.value);remember(editId,e.target.value,color);}}')
s=s.replace('onChange={e=>setColor(e.target.value as LabelColor)}','onChange={e=>{setColor(e.target.value as LabelColor);remember(editId,name,e.target.value as LabelColor);}}')
s=s.replace('if(await save.send(c)){await reload();router.refresh();}', 'if(await save.send(c)){try{sessionStorage.removeItem(formKey);}catch{}await reload();router.refresh();}')
s=s.replace('if(await save.send(save.pending)){await reload();router.refresh();}', "const action=save.pending.action;if(await save.send(save.pending)){try{sessionStorage.removeItem(action==='labels.set'?key:formKey);}catch{}await reload();router.refresh();}")
p.write_text(s)
print('Review preparation complete; original assertions retained.')
