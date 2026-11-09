/**
 * Automated XY refreshes already persist a row in vms_sync_runs for every
 * start and completion. Avoid duplicating only *routine successful* machine
 * telemetry in system_activity_logs; retain all warnings, errors, and
 * user-triggered runs for the human audit timeline.
 *
 * This only controls the additional audit event: never suppresses the
 * authoritative vms_sync_runs insert/update.
 */
export function shouldLogXySyncStart(profile: unknown): boolean {
  return profile !== null && profile !== undefined;
}

export function shouldLogXySyncFinish(
  profile: unknown,
  status: string,
  statusPersistenceFailed = false,
): boolean {
  return profile !== null && profile !== undefined
    || status !== "completed"
    || statusPersistenceFailed;
}
