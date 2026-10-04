import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextTrip, dispatchReadiness, visibleLaterIntentions, canReleasePreparation } from '../src/lib/self-dispatch-workflow.ts';
const now = new Date('2026-10-04T10:00:00Z');
const machine = (machineId, priority = 'today', overrides = {}) => ({ machineId, name: machineId, priority, eligible: true, openToday: true, claimedBy: null, ...overrides });
const board = [machine('Khalij', 'urgent'), machine('HT Mall', 'immediate'), machine('Attahadi')];
const plan = (overrides = {}) => ({ lanes: [], pickup: [{ productId: 'p', productName: 'P', category: null, quantity: 8 }], totalUnits: 8, emptyAfter: 0, unknownAfter: 0, underfilled: 0, replacements: 0, ready: true, requiresAcknowledgement: false, errors: [], ...overrides });
test('one stop now leaves two unclaimed without mutating the shared board', () => {
  const before = structuredClone(board);
  const result = selectNextTrip(board, 1);
  assert.deepEqual(result.selectedMachineIds, ['HT Mall']);
  assert.deepEqual(result.deferredMachineIds, ['Khalij', 'Attahadi']);
  assert.deepEqual(board, before);
});
test('the next trip uses the refreshed board, not the earlier selection', () => {
  assert.deepEqual(selectNextTrip([machine('Khalij', 'urgent', { claimedBy: 'basheer' }), machine('Attahadi', 'urgent')], 1).selectedMachineIds, ['Attahadi']);
});
test('urgent work left behind remains visibly uncovered', () => {
  assert.deepEqual(selectNextTrip([machine('A', 'immediate'), machine('B', 'immediate')], 1).uncoveredImmediateMachineIds, ['B']);
});
test('closed, claimed, out-of-scope and unverified machines cannot enter routine dispatch', () => {
  const result = selectNextTrip([machine('A', 'urgent', { eligible: false }), machine('B', 'urgent', { openToday: false }), machine('C', 'urgent', { claimedBy: 'noury' }), machine('D', 'verify')], 3);
  assert.equal(result.selectedMachineIds.length, 0);
  assert.deepEqual(result.excluded.map(x => x.reason), ['outside_scope', 'closed', 'already_claimed', 'verify']);
});
test('invalid stop counts and duplicate machine IDs are rejected', () => {
  for (const n of [0, 7, NaN, 1.5]) assert.throws(() => selectNextTrip(board, n));
  assert.throws(() => selectNextTrip([machine('A'), machine('A')], 1));
});
test('a complete plan needs no manual owner-approval gate', () => {
  assert.equal(dispatchReadiness(plan()).canStartRoutine, true);
});
test('one unit in every lane is not mislabelled a complete refill', () => {
  const result = dispatchReadiness(plan({ underfilled: 12 }));
  assert.equal(result.canStartRoutine, false);
  assert.equal(result.canReviewPartial, true);
  assert.equal(result.requiresAcknowledgement, true);
});
test('empty and unknown lanes remain explicit exceptions', () => {
  for (const field of ['emptyAfter', 'unknownAfter']) assert.equal(dispatchReadiness(plan({ [field]: 1 })).canStartRoutine, false);
});
test('a plan with errors or no pickup stock cannot be dispatched', () => {
  assert.equal(dispatchReadiness(plan({ errors: ['Unknown machine'] })).blocked, true);
  assert.equal(dispatchReadiness(plan({ pickup: [], totalUnits: 0 })).blocked, true);
});
test('later intentions do not block another operator and disappear after a real claim', () => {
  const intention = { machineId: 'Khalij', operatorId: 'noury', plannedAt: '2026-10-04T14:00:00Z' };
  assert.equal(visibleLaterIntentions([intention], board, now).length, 1);
  assert.deepEqual(selectNextTrip(board, 2).selectedMachineIds, ['HT Mall', 'Khalij']);
  assert.equal(visibleLaterIntentions([intention], [machine('Khalij', 'urgent', { claimedBy: 'basheer' })], now).length, 0);
});
test('an expired preparation releases only when nothing has been picked or started', () => {
  const x = { started: false, pickedUnits: 0, hasCustody: false, expiresAt: '2026-10-04T09:00:00Z', now };
  assert.equal(canReleasePreparation(x), true);
  for (const extra of [{ started: true }, { pickedUnits: 1 }, { hasCustody: true }, { pickedUnits: NaN }, { expiresAt: 'bad' }]) assert.equal(canReleasePreparation({ ...x, ...extra }), false);
});
