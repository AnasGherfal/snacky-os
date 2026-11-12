import hashlib,json
from pathlib import Path
root=Path.cwd();changes=json.loads((root/'.growth-continuation/changes.json').read_text());assert len(changes)==6
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
print('Applied',len(pending),'verified fixes; no database connections.')
