import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";

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

function supabaseClient(key) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createQaUser({ service, email, password, role, roles }) {
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(authError);
  assert.ok(authUser.user?.id);

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

  const { error: profileError } = await service.from("profiles").insert({
    id: authUser.user.id,
    full_name: `Smoke ${role}`,
    email,
    role,
    roles,
    active_status: "active",
    team_member_id: teamMember.id,
    can_add_products: roles.includes("warehouse") || roles.includes("owner") || roles.includes("admin"),
  });
  assert.ifError(profileError);

  const authClient = supabaseClient(anonKey);
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
  return fetch(`${baseUrl}${path}`, {
    redirect,
    headers: { cookie },
  });
}

async function assertPageOk(path, cookie) {
  const response = await fetchPage(path, cookie);
  assert.ok(response.status < 500, `${path} returned ${response.status}`);
  assert.equal(response.redirected && response.url.includes("/login"), false, `${path} redirected to login`);
  const body = await response.text();
  assert.equal(body.includes("Application error"), false, `${path} rendered an application error`);
  assert.equal(body.includes("Server Components render"), false, `${path} rendered a Server Components crash`);
}

test("authenticated high-risk pages render without crash and viewer is redirected", { skip: canRun ? false : "Supabase local env is not configured." }, async () => {
  const service = supabaseClient(serviceRoleKey);
  const id = randomUUID().slice(0, 8);
  const password = `Smoke-${id}-pass-12345`;
  const created = { authUserIds: [], teamMemberIds: [] };

  try {
    const owner = await createQaUser({
      service,
      email: `smoke-owner-${id}@snacky.test`,
      password,
      role: "owner",
      roles: ["owner"],
    });
    created.authUserIds.push(owner.authUserId);
    created.teamMemberIds.push(owner.teamMemberId);

    const warehouse = await createQaUser({
      service,
      email: `smoke-warehouse-${id}@snacky.test`,
      password,
      role: "warehouse",
      roles: ["operator", "warehouse"],
    });
    created.authUserIds.push(warehouse.authUserId);
    created.teamMemberIds.push(warehouse.teamMemberId);

    const operator = await createQaUser({
      service,
      email: `smoke-operator-${id}@snacky.test`,
      password,
      role: "operator",
      roles: ["operator"],
    });
    created.authUserIds.push(operator.authUserId);
    created.teamMemberIds.push(operator.teamMemberId);

    const viewer = await createQaUser({
      service,
      email: `smoke-viewer-${id}@snacky.test`,
      password,
      role: "viewer",
      roles: ["viewer"],
    });
    created.authUserIds.push(viewer.authUserId);
    created.teamMemberIds.push(viewer.teamMemberId);

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
    if (created.authUserIds.length) await service.from("profiles").delete().in("id", created.authUserIds);
    if (created.teamMemberIds.length) await service.from("team_members").delete().in("id", created.teamMemberIds);
    for (const authUserId of created.authUserIds) {
      await service.auth.admin.deleteUser(authUserId);
    }
  }
});
