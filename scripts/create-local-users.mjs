import { readFileSync } from "node:fs";
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
    // Optional local file.
  }
}

loadEnvFile(".env.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRoleKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
}

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const users = [
  {
    email: "anas@snacky.local",
    password: "12345678!",
    full_name: "Anas Snacky",
    role: "owner",
    roles: ["owner", "admin"],
    can_add_products: true,
  },
  {
    email: "test@snacky.local",
    password: "12345678!",
    full_name: "Snacky Operator",
    role: "operator",
    roles: ["operator"],
    can_add_products: false,
  },
];

async function upsertAuthUser(user) {
  const { data: listData, error: listError } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listError) throw listError;
  const existing = listData.users.find((entry) => entry.email === user.email);
  if (existing) return existing;

  const created = await service.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: { full_name: user.full_name },
  });
  if (created.error) throw created.error;
  return created.data.user;
}

async function upsertTeamMemberAndProfile(user, authUserId) {
  const teamPayload = {
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    roles: user.roles,
    active: true,
    active_status: "active",
    auth_user_id: authUserId,
    can_add_products: user.can_add_products,
    must_change_password: false,
  };

  const { data: existingTeamMember, error: teamLookupError } = await service.from("team_members").select("id").eq("email", user.email).maybeSingle();
  if (teamLookupError) throw teamLookupError;

  let teamMemberId = existingTeamMember?.id ?? null;
  if (teamMemberId) {
    const { error: teamUpdateError } = await service.from("team_members").update(teamPayload).eq("id", teamMemberId);
    if (teamUpdateError) throw teamUpdateError;
  } else {
    const { data: insertedTeamMember, error: teamInsertError } = await service
      .from("team_members")
      .insert(teamPayload)
      .select("id")
      .single();

    if (teamInsertError) throw teamInsertError;
    teamMemberId = insertedTeamMember.id;
  }

  const profilePayload = {
    id: authUserId,
    full_name: user.full_name,
    email: user.email,
    phone: null,
    role: user.role,
    roles: user.roles,
    active_status: "active",
    team_member_id: teamMemberId,
    can_add_products: user.can_add_products,
    must_change_password: false,
    last_login_at: null,
  };

  const { error: profileError } = await service.from("profiles").upsert(profilePayload);
  if (profileError) throw profileError;

  return teamMemberId;
}

for (const user of users) {
  const authUser = await upsertAuthUser(user);
  const teamMemberId = await upsertTeamMemberAndProfile(user, authUser.id);
  console.log(JSON.stringify({ email: user.email, auth_user_id: authUser.id, team_member_id: teamMemberId }, null, 2));
}
