# Device notifications

## Scope

This release enables the existing server-originated `route_assigned` notifications and self-service tests. Company notices, CRM updates, cash changes and rent reminders are **not** automatically routed to Web Push by this change. In-app notifications and phone pushes are different delivery channels.

## Rollout

Apply `20260919170000_push_notification_activation.sql`. It bootstraps the two missing tables, restricts access with RLS and grants, and adds an atomic 30-second test cooldown. It is additive and rerunnable; it does not backfill notifications or touch routes, stock, cash or finance records. The original 202607020002 migration need not have run beforehand. Deploy the code, then refresh the installed PWA.

The existing explicit VAPID environment trio remains supported. Otherwise the server continues deriving the same deterministic VAPID pair from its existing service credential. No credentials are shipped to clients. Rotating that server credential changes the fallback pair and devices must re-enable. Dedicated stable VAPID credentials are preferable when configuring future deployments; do not rotate existing keys casually.

## Activation and physical-device acceptance

Open Account, or the notification bell, and Enable notifications. On iOS/iPadOS 16.4+, use the Home Screen-installed app. Permission is requested directly from the tap, then service-worker activation is awaited. Registration is only shown after the server verifies this exact account, endpoint, subscription keys and active state. A browser permission or another registered device is not sufficient.

Test now targets this device, not every device on the account. Test after closing app returns 202, then Next `after()` keeps a 15-second server-side diagnostic alive using the host's waitUntil support. Close the PWA before it is sent, check the notification and tap it to reopen Account. Repeat with a real route assignment to an operator. Test Arabic/English, Android and iPhone, denied permission, stale key, sign-out and multiple devices.

A push-service acceptance is not proof of display or reading. Phone settings, Focus and connectivity may suppress or delay display. The delayed diagnostic is bounded by a 60-second function duration and is not a durable/retrying job scheduler. Server termination can interrupt it; retry the diagnostic. Do not reuse it for business deadlines.

Disable this device only disables its own saved endpoint. Existing sign-out paths intentionally continue deactivating the account's registrations for safety; other signed-in devices must re-enable. This release detects that stale state rather than incorrectly showing Enabled. Changing account in the same browser may require replacing its subscription; RLS never transfers another account's endpoint.

## Verification

The PWA push release workflow runs scoped lint, full typecheck, behavioral tests exercising the actual API/sender/service-worker modules with transport/framework boundaries mocked, retained Topbar/role regression tests, PostgreSQL 17 fresh/previously provisioned migration tests, RLS/ownership/grant/rate-limit assertions, critical-workflow regressions and the production build including its existing prebuild regressions. Mock transport tests cannot prove physical-device notification receipt.

`node --test scripts/test-pwa-push.mjs scripts/test-notification-activation.mjs`

The `scripts/push-tests/bootstrap.sql` file is exclusively for a disposable CI database, never production. The SQL test fixtures roll back. No production users, test routes or notification campaigns are created by these tests.

## Safety and rollback

Sender validates known HTTPS browser push endpoints again even if a subscription was inserted directly into the database. Notification clicks are constrained to same-origin app destinations. Expired 404/410 subscriptions are disabled. A concurrent disable cannot be reversed by an in-flight successful push response. Test sending is restricted to the authenticated active account and rate limited.

Rollback the app deployment to the previous commit if necessary; retain the additive notification tables so saved subscriptions and history are not destroyed. Business data and the CRM scheduler are untouched. No paid push provider, Firebase project or additional cron job is introduced.

## Platform references

- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://nextjs.org/docs/app/api-reference/functions/after
- https://nextjs.org/docs/app/guides/progressive-web-apps
