import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { assertDisposableQaTarget, fetchLocalQaPage, assertRenderedQaPage } from "./qa-target-safety.mjs";

function loadEnvFile(path) {
  try {
    const rows = readFileSync(path, "utf8").split(/\r?\n/);
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index);
      const value = trimmed.slice(index + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // CI can provide env vars directly.
  }
}

loadEnvFile(".env.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const baseUrl = process.env.SNACKY_SMOKE_BASE_URL ?? "http://127.0.0.1:3001";
const canRun = Boolean(supabaseUrl && anonKey && serviceRoleKey);
if (canRun) assertDisposableQaTarget({ appUrl: baseUrl, databaseUrl: supabaseUrl, deploymentEnvironment: process.env.VERCEL_ENV });

function supabaseClient(key) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createQaUser({ service, created, email, password, role, roles }) {
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(authError);
  assert.ok(authUser.user?.id);
  created.authUserIds.push(authUser.user.id);

  const { data: teamMember, error: teamError } = await service
    .from("team_members")
    .insert({
      full_name: `Smoke ${role}`,
      email,
      role,
      roles,
      active: true,
      auth_user_id: authUser.user.id,
      can_add_products: roles.includes("warehouse") || roles.includes("owner") || roles.includes("admin"),
    })
    .select("id")
    .single();
  assert.ifError(teamError);
  created.teamMemberIds.push(teamMember.id);

  const { error: profileError } = await service.from("profiles").insert({
    id: authUser.user.id,
    full_name: `Smoke ${role}`,
    email,
    role,
    roles,
    active_status: "active",
    must_change_password: false,
    team_member_id: teamMember.id,
    can_add_products: roles.includes("warehouse") || roles.includes("owner") || roles.includes("admin"),
  });
  assert.ifError(profileError);

  const authClient = supabaseClient(anonKey);
  created.clients.push(authClient);
  const { data: sessionData, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert.ok(sessionData.session?.access_token);
  assert.ok(sessionData.session?.refresh_token);

  return {
    authUserId: authUser.user.id,
    teamMemberId: teamMember.id,
    cookie: [
      `snacky-auth-access-token=${sessionData.session.access_token}`,
      `snacky-auth-refresh-token=${sessionData.session.refresh_token}`,
    ].join("; "),
  };
}

async function fetchPage(path, cookie, redirect = "follow") {
  return fetchLocalQaPage(baseUrl, path, cookie, redirect);
}

async function assertPageOk(path, cookie) {
  const response = await fetchPage(path, cookie);
  const body = await response.text();
  assertRenderedQaPage({ status: response.status, finalUrl: response.url,
    contentType: response.headers.get("content-type"), body }, baseUrl, path);
}

test("authenticated high-risk pages render without crash and viewer is redirected", { skip: canRun ? false : "Supabase local env is not configured." }, async () => {
  const service = supabaseClient(serviceRoleKey);
  const id = randomUUID().slice(0, 8);
  const password = `Smoke-${id}-pass-12345`;
  const created = { authUserIds: [], teamMemberIds: [], clients: [] };

  try {
    const owner = await createQaUser({
      service, created,
      email: `smoke-owner-${id}@snacky.test`,
      password,
      role: "owner",
      roles: ["owner"],
    });

    const warehouse = await createQaUser({
      service, created,
      email: `smoke-warehouse-${id}@snacky.test`,
      password,
      role: "warehouse",
      roles: ["operator", "warehouse"],
    });

    const operator = await createQaUser({
      service, created,
      email: `smoke-operator-${id}@snacky.test`,
      password,
      role: "operator",
      roles: ["operator"],
    });

    const viewer = await createQaUser({
      service, created,
      email: `smoke-viewer-${id}@snacky.test`,
      password,
      role: "viewer",
      roles: ["viewer"],
    });

    for (const path of [
      "/dashboard",
      "/inventory",
      "/inventory/movements",
      "/inventory-dashboard",
      "/products",
      "/products/new",
      "/products-dashboard",
      "/restock-priority",
      "/purchases",
      "/purchases/new",
      "/routes",
      "/routes/new",
      "/machines",
      "/machines-dashboard",
      "/locations",
      "/suppliers",
      "/cash-collections",
      "/finance",
      "/finance/import",
      "/finance/import/review",
      "/reports",
      "/sales",
      "/vms-import",
      "/vms-import/sources",
    ]) {
      await assertPageOk(path, owner.cookie);
    }

    for (const path of ["/inventory/movements/new", "/storage-locations", "/purchases/new", "/products/new"]) {
      await assertPageOk(path, warehouse.cookie);
    }

    for (const path of ["/operator", "/operator/routes"]) {
      await assertPageOk(path, operator.cookie);
    }

    const unauthorized = await fetchPage("/inventory", viewer.cookie, "manual");
    assert.ok([303, 307, 308].includes(unauthorized.status), `viewer /inventory should redirect, got ${unauthorized.status}`);
    assert.match(unauthorized.headers.get("location") ?? "", /\/unauthorized/);
  } finally {
    // Attempt every cleanup even when one operation fails. This target is
    // loopback-only; the CI also destroys the complete disposable stack.
    const cleanupErrors = [];
    async function cleanup(operation) {
      try { const result = await operation(); if (result?.error) cleanupErrors.push(result.error); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const client of created.clients) await cleanup(() => client.auth.signOut({ scope: "global" }));
    if (created.authUserIds.length) await cleanup(() => service.from("profiles").delete().in("id", created.authUserIds));
    if (created.teamMemberIds.length) await cleanup(() => service.from("team_members").delete().in("id", created.teamMemberIds));
    for (const authUserId of created.authUserIds) await cleanup(() => service.auth.admin.deleteUser(authUserId));
    assert.equal(cleanupErrors.length, 0, "Some disposable fixture identities could not be cleaned up.");
  }
});
