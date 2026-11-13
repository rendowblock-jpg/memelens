export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type TaskKind = "snapshot" | "path72" | "path30d";

export interface TaskPlan {
  kind: TaskKind;
  /** Unix ms: the task may run from here. */
  dueAt: number;
  /** Unix ms: after this the task is given up (marked missed), because a later reading would be a different measurement. */
  deadlineAt: number;
}

/**
 * What is read for one followed token, from the time its pool was created (t0). The first-hour snapshot is time-critical
 * (it is the scoring input), so it has 15 minutes of grace; the two path readings mostly read history (hourly candles),
 * so they have hours.
 */
export function planTasks(createdAt: number): TaskPlan[] {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new RangeError(`createdAt must be a non-negative whole number of ms, got ${createdAt}`);
  return [
    { kind: "snapshot", dueAt: createdAt + 60 * MINUTE, deadlineAt: createdAt + 75 * MINUTE },
    { kind: "path72", dueAt: createdAt + 72 * HOUR, deadlineAt: createdAt + 78 * HOUR },
    { kind: "path30d", dueAt: createdAt + 30 * DAY, deadlineAt: createdAt + 30 * DAY + 12 * HOUR },
  ];
}
