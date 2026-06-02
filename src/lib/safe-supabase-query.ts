type SupabaseLikeError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

type SupabaseLikeResult<T> = {
  data?: T[] | null;
  count?: number | null;
  error?: SupabaseLikeError | null;
};

export function supabaseQueryErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown Supabase error");
  const row = error as SupabaseLikeError;
  return [row.code, row.message, row.details, row.hint]
    .map((value) => String(value ?? ""))
    .filter(Boolean)
    .join(" - ") || "Unknown Supabase error";
}

export async function safeSupabaseQuery<T>({
  label,
  promise,
  fallback = [],
}: {
  label: string;
  promise: PromiseLike<SupabaseLikeResult<T>>;
  fallback?: T[];
}) {
  try {
    const result = await promise;
    if (result.error) {
      const message = supabaseQueryErrorMessage(result.error);
      console.error("[safe-supabase-query] Query failed", { label, error: result.error });
      return { data: fallback, count: 0, error: message };
    }
    return { data: (result.data ?? fallback) as T[], count: result.count ?? 0, error: null as string | null };
  } catch (error) {
    const message = supabaseQueryErrorMessage(error);
    console.error("[safe-supabase-query] Query threw", { label, error });
    return { data: fallback, count: 0, error: message };
  }
}
