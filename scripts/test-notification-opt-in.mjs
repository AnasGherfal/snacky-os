import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  NOTIFICATION_PROMPT_SNOOZE_MS, BLOCKED_PROMPT_SNOOZE_MS,
  canShowNotificationPrompt, markNotificationPromptShown, snoozeNotificationPrompt,
  notificationPromptKeys, notificationPromptRouteAllowed, shouldOfferNotificationPrompt,
  rememberNotificationDeviceDisabled, clearNotificationDeviceDisabled,
} from '../src/lib/notification-prompt.ts';

function store() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const stores = () => ({ local: store(), session: store() });

test('offer only actionable states with a ready server', () => {
  for (const state of ['available', 'install', 'blocked']) {
    assert.equal(shouldOfferNotificationPrompt(state, true), true);
    assert.equal(shouldOfferNotificationPrompt(state, false), false);
  }
  for (const state of ['enabled', 'checking', 'unsupported', 'error', 'unknown']) {
    assert.equal(shouldOfferNotificationPrompt(state, true), false);
  }
});
test('exclude public pages and existing settings, including nested routes', () => {
  for (const path of [null, '/login', '/login/reset', '/unauthorized', '/account', '/account/security', '/notifications', '/notifications/all']) {
    assert.equal(notificationPromptRouteAllowed(path), false);
  }
  for (const path of ['/my-work', '/operator/routes', '/locations-pipeline', '/inventory']) {
    assert.equal(notificationPromptRouteAllowed(path), true);
  }
});
test('never show without a user; invite is once per browser session and user', () => {
  const s = stores();
  assert.equal(canShowNotificationPrompt('', 100, s), false);
  assert.equal(canShowNotificationPrompt('session-a', 100, s), true);
  markNotificationPromptShown('session-a', s);
  assert.equal(canShowNotificationPrompt('session-a', 100, s), false);
  assert.equal(s.session.getItem(notificationPromptKeys('session-a').seen), '1');
  assert.equal(canShowNotificationPrompt('session-b', 100, s), true);
});
test('Later persists seven days; blocked guidance snoozes for thirty days', () => {
  const s = stores();
  snoozeNotificationPrompt('later-a', false, 1000, s);
  snoozeNotificationPrompt('blocked-a', true, 1000, s);
  assert.equal(Number(s.local.getItem(notificationPromptKeys('later-a').until)), 1000 + NOTIFICATION_PROMPT_SNOOZE_MS);
  assert.equal(Number(s.local.getItem(notificationPromptKeys('blocked-a').until)), 1000 + BLOCKED_PROMPT_SNOOZE_MS);
  assert.equal(canShowNotificationPrompt('later-a', 1001, s), false);
});
test('stored snooze expires and bad storage data is harmless', () => {
  const s = stores();
  s.local.setItem(notificationPromptKeys('expiry-a').until, '5000');
  assert.equal(canShowNotificationPrompt('expiry-a', 4999, s), false);
  assert.equal(canShowNotificationPrompt('expiry-a', 5000, s), true);
  s.local.setItem(notificationPromptKeys('invalid-a').until, 'not-a-date');
  assert.equal(canShowNotificationPrompt('invalid-a', 5000, s), true);
});
test('explicit device disable suppresses invitations until manual enable', () => {
  const s = stores();
  rememberNotificationDeviceDisabled(s);
  assert.equal(canShowNotificationPrompt('disabled-a', 100, s), false);
  clearNotificationDeviceDisabled(s);
  assert.equal(canShowNotificationPrompt('disabled-a', 100, s), true);
});
test('restricted browser storage cannot crash or repeatedly nag in one page', () => {
  const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  const s = { local: broken, session: broken };
  assert.equal(canShowNotificationPrompt('restricted-a', 100, s), true);
  assert.doesNotThrow(() => snoozeNotificationPrompt('restricted-a', false, 100, s));
  assert.equal(canShowNotificationPrompt('restricted-a', 101, s), false);
});
test('automatic invitation reuses existing device activation and keeps shell work accessible', () => {
  const card = readFileSync(new URL('../src/components/NotificationActivationCard.tsx', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../src/components/ShellChrome.tsx', import.meta.url), 'utf8');
  const wrapper = readFileSync(new URL('../src/components/NotificationOptInPrompt.tsx', import.meta.url), 'utf8');
  assert.match(shell, /NotificationOptInPrompt userId=\{profile\.id\}/);
  assert.match(wrapper, /key=\{userId\} autoPromptFor=\{userId\}/);
  assert.match(card, /verified\.deviceRegistered/);
  assert.doesNotMatch(card, /activeSubscriptions\s*(?:>|===|!==)/);
  const enable = card.slice(card.indexOf('async function enable()'), card.indexOf('async function sendTest'));
  assert.ok(enable.indexOf('Notification.requestPermission()') < enable.indexOf('await getPushRegistration()'));
  assert.ok(enable.indexOf('saved?.saved !== true') < enable.indexOf('setPromptRegistered(true)'));
  assert.match(enable, /Notification\.permission === "denied"/);
  assert.equal((card.match(/Notification\.requestPermission\(/g) ?? []).length, 1);
  const invitation = card.slice(card.indexOf('if (autoPromptFor) {'), card.indexOf('aria-label={ar ? "إشعارات الجهاز"'));
  assert.doesNotMatch(invitation, /aria-modal|role="dialog"|fixed inset/);
  assert.match(invitation, /dir=\{ar \? "rtl" : "ltr"\}/);
});
