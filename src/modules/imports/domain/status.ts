import { IMPORT_STATUSES, type ImportStatus } from './types';

/**
 * The import lifecycle. This table is the single source of truth: the service and processor
 * reason with it, and the repository derives every conditional `WHERE status IN (...)` from it
 * (via `sourcesOf`), so the database enforces exactly the same machine.
 */
export const TRANSITIONS: Readonly<Record<ImportStatus, readonly ImportStatus[]>> = {
  AWAITING_UPLOAD: ['QUEUED'],
  // AWAITING_UPLOAD: rollback when enqueueing fails. FAILED: retries exhausted before a run began.
  QUEUED: ['AWAITING_UPLOAD', 'PROCESSING', 'FAILED'],
  // PROCESSING -> PROCESSING: a redelivered message takes over the run of a dead worker.
  PROCESSING: ['PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'],
  COMPLETED: [],
  COMPLETED_WITH_ERRORS: [],
  FAILED: [],
};

export function canTransition(from: ImportStatus, to: ImportStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` can be reached. */
export function sourcesOf(to: ImportStatus): ImportStatus[] {
  return IMPORT_STATUSES.filter((from) => canTransition(from, to));
}

export function isTerminal(status: ImportStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses after which a job must never be processed again (derived from TRANSITIONS). */
export const TERMINAL_STATUSES: ReadonlySet<ImportStatus> = new Set(
  IMPORT_STATUSES.filter(isTerminal),
);
