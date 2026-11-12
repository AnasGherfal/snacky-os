import hashlib,json
from pathlib import Path
root=Path.cwd();changes=json.loads((root/'.growth-continuation/changes.json').read_text());assert len(changes)==6
changes.append(json.loads((root/'.growth-continuation/pickup.json').read_text()))
pending={}
for edit in changes:
 path=edit['path'];assert path.startswith(('src/','scripts/')) and '..' not in Path(path).parts
 p=root/path;original=p.read_bytes();digest=hashlib.sha256(original).hexdigest()
 if digest==edit['result']:continue
 assert digest==edit['base'],'Unexpected base: '+path
 lines=original.decode().splitlines(keepends=True)
 for start,end,replacement in reversed(edit['ops']):lines[start:end]=[replacement]
 text=''.join(lines)
 assert hashlib.sha256(text.encode()).hexdigest()==edit['result'],'Transport mismatch: '+path
 pending[p]=text
for p,text in pending.items():p.write_text(text)
p=root/'scripts/growth-e2e/run.mjs';s=p.read_text()
old="largeRoute={id:randomUUID(),route_date:today,status:'draft'"
new="largeRoute={id:randomUUID(),route_date:today,operator_id:operators[0].member,status:'draft'"
if old in s:
 assert s.count(old)==1;s=s.replace(old,new)
marker="  await check('cross-operator route identifiers are denied under 20 simultaneous requests',async()=>{"
addition="  await check('large operator pickup API includes all 1,500 planned lines and 50 stops',async()=>{\n    const data=await json(`/api/operator/routes/${largeRoute.id}/pick-list`,operators[0]);\n    assert.equal(data.routeItemCount,1500);assert.equal(data.pendingStopCount,50);\n  });\n"
if "large operator pickup API includes all 1,500" not in s:
 assert s.count(marker)==1;s=s.replace(marker,addition+marker)
p.write_text(s)
print('Applied',len(pending),'verified fixes; no database connections.')
