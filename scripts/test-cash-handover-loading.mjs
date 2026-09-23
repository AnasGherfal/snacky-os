import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ui = readFileSync(new URL('../src/components/CashHandlingWorkspace.tsx', import.meta.url), 'utf8');

test('cash retry is restored before the interactive workspace mounts', () => {
  assert.match(ui, /useSyncExternalStore\(subscribeHydration, clientSnapshot, serverSnapshot\)/);
  assert.match(ui, /useState\(\(\) => browserState\(storageKey\)\)/);
  assert.match(ui, /CashHandlingClient key=\{userId\}/);
  assert.doesNotMatch(ui, /setReady\(/);
});

test('cash loading only applies current network results and invalidates on unmount', () => {
  const loader = ui.slice(ui.indexOf('  const load = useCallback('), ui.indexOf('  function keep'));
  assert.match(loader, /return fetch\(/);
  assert.match(loader, /\.then\(data => \{ if \(seq === sequence.current\) setView\(data\)/);
  assert.match(loader, /return \(\) => \{ sequence.current \+= 1; \}/);
  assert.doesNotMatch(loader, /setLoading\(true\)/);
});
