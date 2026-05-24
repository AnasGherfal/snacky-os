export type ActionResult<T = Record<string, unknown>> =
  | ({ success: true; error?: never } & T)
  | ({ success: false; error: string; code?: string; debug?: string } & Partial<T>);

export function actionSuccess<T extends Record<string, unknown> = Record<string, never>>(payload?: T): ActionResult<T> {
  return { success: true, ...payload } as ActionResult<T>;
}

export function actionFailure<T extends Record<string, unknown> = Record<string, never>>(
  error: string,
  payload?: Partial<T> & { code?: string; debug?: string },
): ActionResult<T> {
  return { success: false, error, ...(payload ?? {}) } as ActionResult<T>;
}
