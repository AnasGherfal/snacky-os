import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRouteListSupport } from '../src/lib/route-list-support.ts';

function database(responses) {
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: [] };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return this; },
      in(column, values) { call.filters.push([column, values]); return this; },
      order(column, options) { call.order = [column, options]; return this; },
      abortSignal(signal) { call.signal = signal; return this; },
      then(resolve, reject) {
        const response = responses[table]?.shift();
        if (!response) return Promise.reject(new Error(`Unexpected read: ${table}`)).then(resolve, reject);
        return Promise.resolve(response).then(resolve, reject);
      },
    };
    return query;
  }};
  return { db, calls };
}
const machine = { id: 'm1', name: 'Machine', machine_code: 'M1', location: { id: 'l1', name: 'Site' } };
const stop = { route_id: 'r1', machine_id: 'm1', stop_order: 1 };

test('normal summary is two parallel reads, no extra machine round trip', async () => {
  const { db, calls } = database({ team_members: [{ data: [{ id: 'u1', full_name: 'Operator' }], error: null }], route_stops: [{ data: [{ ...stop, machine }], error: null }] });
  const result = await loadRouteListSupport(db, ['r1'], ['u1']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.table), ['team_members', 'route_stops']);
  assert.match(calls[1].columns, /machine:machines.*location:locations/);
  assert.deepEqual(calls[1].filters, [['route_id', ['r1']]]);
  assert.deepEqual(calls[0].filters, [['id', ['u1']]]);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(result.stops.data[0].machine.location.name, 'Site');
});

test('empty authorized page makes no support reads', async () => {
  const { db, calls } = database({});
  const result = await loadRouteListSupport(db, [], []);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.stops.data, []);
});

test('old schema fallback stays scoped and uses the same deadline', async () => {
  const { db, calls } = database({ route_stops: [
    { data: null, error: { code: 'PGRST200', message: 'Relationship missing' } },
    { data: [stop], error: null },
  ], machines: [{ data: [machine], error: null }] });
  const result = await loadRouteListSupport(db, ['r1'], []);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.signal === calls[0].signal));
  assert.deepEqual(calls[1].filters, [['route_id', ['r1']]]);
  assert.deepEqual(calls[2].filters, [['id', ['m1']]]);
  assert.deepEqual(result.stops.data, [{ ...stop, machine }]);
});

for (const code of ['42501', '57014', 'PGRST301', '']) {
  test(`does not repeat a denied/timeout/network request (${code || 'network'})`, async () => {
    const error = { code, message: 'Unavailable' };
    const { db, calls } = database({ route_stops: [{ data: null, error }] });
    const result = await loadRouteListSupport(db, ['r1'], []);
    assert.equal(calls.length, 1);
    assert.equal(result.stops.error, error);
    assert.equal(result.stops.data, null);
  });
}

test('missing fallback machine labels do not hide real stops', async () => {
  const machineError = { code: '42703', message: 'Column missing' };
  const { db } = database({ route_stops: [
    { data: null, error: { code: 'PGRST200', message: 'Relationship missing' } },
    { data: [stop], error: null },
  ], machines: [{ data: null, error: machineError }] });
  const result = await loadRouteListSupport(db, ['r1'], []);
  assert.deepEqual(result.stops.data, [{ ...stop, machine: null }]);
  assert.equal(result.stops.machineError, machineError);
  assert.equal(result.stops.error, null);
});
