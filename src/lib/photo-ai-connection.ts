/** Server-side credential selection. Never send this module's Connection to the browser.
 * Vercel supplies a fresh request token in x-vercel-oidc-token; prefer it to the
 * environment fallback. AI Gateway verifies the token signature and team access.
 * https://vercel.com/docs/ai-gateway/authentication-and-byok
 * https://vercel.com/docs/oidc
 */
export type PhotoAiEnvironment = Readonly<{
  [name: string]: string | undefined;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  VERCEL_OIDC_TOKEN?: string;
  VERCEL?: string;
  XY_PHOTO_VISION_MODEL?: string;
}>;

export type PhotoAiConnection = {
  provider: "openai" | "vercel_gateway";
  authMethod: "api_key" | "vercel_oidc";
  url: string;
  token: string;
  model: string;
};

const clean = (value: string | null | undefined) => value?.trim() || "";

export function resolvePhotoAiConnection(
  env: PhotoAiEnvironment,
  headers: Pick<Headers, "get">,
): PhotoAiConnection | null {
  const directKey = clean(env.OPENAI_API_KEY);
  const gatewayKey = clean(env.AI_GATEWAY_API_KEY);
  // Never accept caller-supplied credentials on a non-Vercel server.
  const oidc = env.VERCEL === "1"
    ? clean(headers.get("x-vercel-oidc-token")) || clean(env.VERCEL_OIDC_TOKEN)
    : "";
  if (!directKey && !gatewayKey && !oidc) return null;
  const model = (clean(env.XY_PHOTO_VISION_MODEL) || "gpt-4.1-mini").replace(/^openai\//, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}$/.test(model)) {
    throw new Error("PHOTO_AI_INVALID_MODEL");
  }
  if (directKey) {
    return { provider: "openai", authMethod: "api_key", url: "https://api.openai.com/v1/responses", token: directKey, model };
  }
  return {
    provider: "vercel_gateway",
    authMethod: gatewayKey ? "api_key" : "vercel_oidc",
    url: "https://ai-gateway.vercel.sh/v1/responses",
    token: gatewayKey || oidc,
    model: `openai/${model}`,
  };
}

export function publicPhotoAiConnection(connection: PhotoAiConnection | null) {
  // Presence of a credential is NOT a successful model call or a balance check.
  return {
    configured: Boolean(connection),
    provider: connection?.provider ?? null,
    authMethod: connection?.authMethod ?? null,
    model: connection?.model ?? null,
    connectionVerified: false,
  };
}

export function photoAiFailure(status: number, provider: PhotoAiConnection["provider"]) {
  const gateway = provider === "vercel_gateway";
  if (status === 402) return {
    code: "PHOTO_AI_CREDITS_REQUIRED",
    error: gateway
      ? "Vercel AI Gateway requires available credits or account activation. No credit purchase or top-up was made."
      : "OpenAI API billing or credits require attention. No payment settings were changed.",
  };
  if (status === 401 || status === 403) return {
    code: "PHOTO_AI_ACCESS_REQUIRED",
    error: gateway
      ? "Vercel did not authorize AI Gateway access. The project's OIDC identity or team AI Gateway access needs attention; no photo was analyzed."
      : "OpenAI did not authorize this API key. Check the server-side key and its project permissions.",
  };
  if (status === 429) return {
    code: "PHOTO_AI_LIMIT_REACHED",
    error: "The AI account's rate limit or usage quota was reached. No automatic retry or credit purchase was made.",
  };
  return { code: "PHOTO_AI_PROVIDER_UNAVAILABLE", error: "The AI provider could not analyze the photo. Try again later; no inventory was changed." };
}
