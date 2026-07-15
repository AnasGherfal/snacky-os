export type ActionResult<T = Record<string, unknown>> =
  | ({ success: true; error?: never } & T)
  | ({ success: false; error: string; code?: string; debug?: string } & Partial<T>);

export function actionSuccess<T extends Record<string, unknown> = Record<string, never>>(payload?: T): ActionResult<T> {
  return { success: true, ...payload } as ActionResult<T>;
}

function exactPickupFailure(error: string, payload?: { code?: string; debug?: string }) {
  if (error !== "Could not confirm pickup. Please try again." || !payload?.debug) return error;

  try {
    const debug = JSON.parse(payload.debug) as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const code = String(debug.code ?? payload.code ?? "").trim();
    const message = String(debug.message ?? "").trim();
    const details = String(debug.details ?? "").trim();
    const hint = String(debug.hint ?? "").trim();
    const parts = [message, details, hint].filter((value, index, values) => value && values.indexOf(value) === index);
    if (!parts.length) return error;
    return `${code ? `[${code}] ` : ""}${parts.join(" — ")}`;
  } catch {
    return payload.code ? `${error} [${payload.code}]` : error;
  }
}

export function actionFailure<T extends Record<string, unknown> = Record<string, never>>(
  error: string,
  payload?: Partial<T> & { code?: string; debug?: string },
): ActionResult<T> {
  return { success: false, error: exactPickupFailure(error, payload), ...(payload ?? {}) } as ActionResult<T>;
}
