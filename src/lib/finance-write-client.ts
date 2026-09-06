import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";

export function getRequiredFinanceWriteClient() {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("The server-only finance writer is not configured. Nothing was changed.");
  }
  return client;
}
