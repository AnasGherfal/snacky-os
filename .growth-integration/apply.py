import hashlib
import json
from pathlib import Path

root = Path.cwd()
new_hashes = {
    'docs/growth-readiness-20261112.md': 'aa4c2ea0b13138d0b267b1f6a170273ac95c2d84001cc65c6edc80b484fd6075',
    'scripts/test-growth-hardening.mjs': '3527e8c6d70bc0fd4d73d918816377e82c295fe866a53669b34dfcb253efd72c',
    'src/lib/cash-interval-model.ts': 'c9d2d572343cb26809aecba3a56c1c1419efe77462517130750804898f1b0d64',
    'src/lib/complete-list-read.ts': 'd73a0351cf2dbe013e0847703b1298fbe23bb772185c41dd1204ce4047e131f2',
}
pending = {}
problems = []
for shard in sorted((root / '.growth-integration').glob('part-*.json')):
    for edit in json.loads(shard.read_text())['edits']:
        name = edit['path']
        assert name.startswith(('src/', 'scripts/', 'docs/', '.github/workflows/')) or name == 'package.json'
        assert '..' not in Path(name).parts and name not in pending
        path = root / name
        if edit['base'] is None:
            assert not path.exists(), f'New file already exists: {name}'
            value = edit['content']
            expected = new_hashes[name]
        else:
            original = path.read_bytes()
            assert hashlib.sha256(original).hexdigest() == edit['base'], f'Baseline changed: {name}'
            lines = original.decode('utf-8').splitlines(keepends=True)
            for start, end, replacement in reversed(edit['ops']):
                assert 0 <= start <= end <= len(lines)
                lines[start:end] = [replacement]
            value = ''.join(lines)
            expected = edit['result']
        actual = hashlib.sha256(value.encode()).hexdigest()
        if actual != expected:
            problems.append({'path': name, 'expected': expected, 'actual': actual})
            target = root / 'integration-evidence' / 'mismatches' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
        pending[name] = value
assert len(pending) == 25, f'Incomplete patch: {len(pending)} files'
if problems:
    print(json.dumps(problems, indent=2))
    raise SystemExit('Patch checksum mismatch; application withheld')
for name, value in pending.items():
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding='utf-8')
print('Applied 25 independently checksummed files; no database changes.')
