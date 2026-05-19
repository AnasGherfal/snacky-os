import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const defaultEmail = "anas@snacky.ly";
const defaultName = "Anas";
const args = process.argv.slice(2);

loadOptionalEnvFiles();

const email = cleanEmail(getArgValue("--email") || process.env.SNACKY_FIRST_OWNER_EMAIL || defaultEmail);
const fullName = cleanText(getArgValue("--name") || process.env.SNACKY_FIRST_OWNER_NAME || defaultName);
const confirm = hasArg("--confirm-production-owner");
const allowLocal = hasArg("--allow-local");
const generatePassword = hasArg("--generate-password");
const suppliedPassword =
  getArgValue("--password") ||
  process.env.SNACKY_FIRST_OWNER_TEMP_PASSWORD ||
  process.env.SNACKY_OWNER_TEMP_PASSWORD ||
  "";

let temporaryPassword = suppliedPassword;
let generatedPassword = false;

if (!temporaryPassword && generatePassword) {
  temporaryPassword = generateTemporaryPassword();
  generatedPassword = true;
}

function usage() {
  return [
    "Usage:",
    "  npm run create:first-owner -- --confirm-production-owner --generate-password",
    "  npm run create:first-owner -- --confirm-production-owner",
    "",
    "Defaults:",
    `  --email ${defaultEmail}`,
    `  --name "${defaultName}"`,
    "",
    "Environment:",
    "  NEXT_PUBLIC_SUPABASE_URL              Required. Must point to Supabase Cloud unless --allow-local is set.",
    "  SUPABASE_SERVICE_ROLE_KEY             Required. Use the server-only service role/secret key.",
    "  SNACKY_FIRST_OWNER_TEMP_PASSWORD      Optional. Required unless --generate-password is used or the Auth user already exists.",
    "",
    "Options:",
    "  --confirm-production-owner            Required before writing.",
    "  --generate-password                   Generate and print a one-time temporary password.",
    "  --email <email>                       Override the owner email.",
    "  --name <full name>                    Override the owner full name.",
    "  --password <password>                 Override the temporary password. Prefer env vars to avoid shell history.",
    "  --allow-local                         Allow local Supabase URLs for rehearsal.",
  ].join("\n");
}

function hasArg(flag) {
  return args.includes(flag);
}

function getArgValue(flag) {
  const exact = args.find((arg) => arg.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);

  const index = args.indexOf(flag);
  if (index === -1) return null;
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanEmail(value) {
  return cleanText(value).toLowerCase();
}

function isLocalUrl(value) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(value);
}

function generateTemporaryPassword() {
  return `${randomBytes(18).toString("base64url")}Aa1!`;
}

function loadOptionalEnvFiles() {
  if (typeof process.loadEnvFile !== "function") return;

  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function assertReady() {
  if (!confirm) {
    throw new Error(`Missing --confirm-production-owner.\n\n${usage()}`);
  }

  if (!email || !email.includes("@")) {
    throw new Error("Set a valid owner email.");
  }

  if (!fullName) {
    throw new Error("Set a non-empty owner name.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before creating the first owner.");
  }

  if (!allowLocal && isLocalUrl(supabaseUrl)) {
    throw new Error("Refusing to create a production owner against a local Supabase URL. Use --allow-local only for rehearsal.");
  }

  if (temporaryPassword && temporaryPassword.length < 10) {
    throw new Error("Temporary password must be at least 10 characters.");
  }
}

async function findAuthUserByEmail(supabase, targetEmail) {
  const perPage = 1000;

  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const user = data.users.find((candidate) => cleanEmail(candidate.email) === targetEmail);
    if (user) return user;
    if (data.users.length < perPage) return null;
  }

  throw new Error("Could not find Auth user by email after scanning 100 pages.");
}

async function createOrUpdateAuthUser(supabase) {
  const existingUser = await findAuthUserByEmail(supabase, email);
  const userMetadata = { full_name: fullName };

  if (existingUser) {
    const updatePayload = {
      email,
      email_confirm: true,
      user_metadata: userMetadata,
    };

    if (temporaryPassword) {
      updatePayload.password = temporaryPassword;
    }

    const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, updatePayload);
    if (error || !data.user) throw error ?? new Error("Could not update existing Auth user.");
    return { user: data.user, created: false };
  }

  if (!temporaryPassword) {
    throw new Error("Auth user does not exist yet. Set SNACKY_FIRST_OWNER_TEMP_PASSWORD or pass --generate-password.");
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: userMetadata,
  });

  if (error || !data.user) throw error ?? new Error("Could not create Auth user.");
  return { user: data.user, created: true };
}

async function findTeamMember(supabase, authUserId) {
  const byAuthUser = await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", authUserId)
    .limit(1)
    .maybeSingle();

  if (byAuthUser.error) throw byAuthUser.error;
  if (byAuthUser.data) return byAuthUser.data;

  const byEmail = await supabase
    .from("team_members")
    .select("id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle();

  if (byEmail.error) throw byEmail.error;
  return byEmail.data;
}

async function upsertTeamMember(supabase, authUserId) {
  const existingTeamMember = await findTeamMember(supabase, authUserId);
  const teamMemberPayload = {
    full_name: fullName,
    email,
    role: "owner",
    active: true,
    auth_user_id: authUserId,
    active_status: "active",
    must_change_password: true,
  };

  if (existingTeamMember) {
    const { data, error } = await supabase
      .from("team_members")
      .update(teamMemberPayload)
      .eq("id", existingTeamMember.id)
      .select("id")
      .single();

    if (error || !data) throw error ?? new Error("Could not update team member.");
    return { id: data.id, created: false };
  }

  const { data, error } = await supabase
    .from("team_members")
    .insert(teamMemberPayload)
    .select("id")
    .single();

  if (error || !data) throw error ?? new Error("Could not create team member.");
  return { id: data.id, created: true };
}

async function ensureNoConflictingProfile(supabase, authUserId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email")
    .ilike("email", email)
    .neq("id", authUserId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (data) {
    throw new Error(
      `A profile already uses ${email} with a different Auth user id (${data.id}). Fix that duplicate before running this script.`,
    );
  }
}

async function upsertProfile(supabase, authUserId, teamMemberId) {
  await ensureNoConflictingProfile(supabase, authUserId);

  const profilePayload = {
    id: authUserId,
    full_name: fullName,
    email,
    phone: null,
    role: "owner",
    active_status: "active",
    team_member_id: teamMemberId,
    must_change_password: true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("profiles")
    .upsert(profilePayload, { onConflict: "id" })
    .select("id, email, role, active_status, team_member_id")
    .single();

  if (error || !data) throw error ?? new Error("Could not upsert profile.");
  return data;
}

function printResult({ projectHost, authUser, authCreated, teamMember, profile }) {
  console.log("First owner is ready.");
  console.log(`Project: ${projectHost}`);
  console.log(`Email: ${email}`);
  console.log(`Auth user: ${authUser.id} (${authCreated ? "created" : "updated"})`);
  console.log(`Team member: ${teamMember.id} (${teamMember.created ? "created" : "updated"})`);
  console.log(`Profile: ${profile.id}, role=${profile.role}, active_status=${profile.active_status}`);

  if (generatedPassword) {
    console.log("");
    console.log("Copy this temporary password now. It will not be shown again:");
    console.log(temporaryPassword);
  } else if (temporaryPassword) {
    console.log("");
    console.log("Temporary password was taken from your environment/argument and was not printed.");
  } else {
    console.log("");
    console.log("No password was changed because the Auth user already existed and no temporary password was provided.");
  }
}

async function main() {
  assertReady();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const projectHost = new URL(supabaseUrl).host;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { user: authUser, created: authCreated } = await createOrUpdateAuthUser(supabase);
  const teamMember = await upsertTeamMember(supabase, authUser.id);
  const profile = await upsertProfile(supabase, authUser.id, teamMember.id);

  printResult({ projectHost, authUser, authCreated, teamMember, profile });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
