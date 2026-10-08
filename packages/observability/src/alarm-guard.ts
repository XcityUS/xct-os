import { createLogger } from "./logger.js";

/**
 * Durable Object alarm guardrails: an emergency stop, a floor under re-arm times, an hourly
 * circuit breaker, and failure backoff, so that no `alarm()` handler can become a self-re-arming
 * loop. See `docs/alarm-audit.md` for why every handler needs them.
 */

type AlarmGuardLogFields = {
  alarmKey?: string;
  count?: number;
  maxPerHour?: number;
  failures?: number;
  retryAt?: number;
};

const logger = createLogger<AlarmGuardLogFields>({ component: "observability.alarm-guard" });

const HOUR_MS = 3_600_000;

/** The earliest an alarm armed through {@link scheduleAlarm} may fire, relative to now. */
export const ALARM_FLOOR_MS = 1_000;

/** Prefix of the single storage key a guarded alarm keeps its counters under, when it must. */
export const ALARM_GUARD_KEY_PREFIX = "alarm-guard:";

/**
 * The slice of `DurableObjectState` the guard touches: the alarm and one synchronous KV key
 * (SQLite-backed Durable Objects only). A real `ctx` satisfies it structurally.
 */
export interface AlarmGuardState {
  readonly storage: {
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    readonly kv: {
      get<T>(key: string): T | undefined;
      put<T>(key: string, value: T): void;
      delete(key: string): boolean;
    };
  };
}

/**
 * The emergency-stop variable. Set the Worker var `ALARMS_DISABLED` to `"true"` and redeploy
 * to halt every alarm that checks it within minutes: each one deletes itself the next time it
 * fires.
 */
export type AlarmKillSwitchEnv = { readonly ALARMS_DISABLED?: string };

/** True when the deployment's `ALARMS_DISABLED` emergency stop is on. */
export function alarmsDisabled(env: object): boolean {
  return (env as AlarmKillSwitchEnv).ALARMS_DISABLED === "true";
}

/**
 * The kill-switch check every `alarm()` handler starts with: when `ALARMS_DISABLED` is on it
 * deletes the alarm, logs `alarm.disabled`, and returns true, so the caller returns at once.
 */
export async function haltIfAlarmsDisabled(
  state: AlarmGuardState,
  env: object,
  key: string,
): Promise<boolean> {
  if (!alarmsDisabled(env)) return false;
  await halt(state, key);
  return true;
}

async function halt(state: AlarmGuardState, key: string): Promise<void> {
  await state.storage.deleteAlarm();
  logger.warn("alarm halted by ALARMS_DISABLED", { event: "alarm.disabled", alarmKey: key });
}

/** Options for {@link scheduleAlarm}. */
export type ScheduleAlarmOptions = {
  /** Minimum delay from now. Defaults to {@link ALARM_FLOOR_MS}. */
  floorMs?: number;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Arms the alarm at `atMs`, but never earlier than `now + floorMs`, so a past or present target
 * (a backlog, or state that failed to advance) cannot fire the alarm in a tight loop. Returns the
 * time actually armed. Writes nothing besides the alarm.
 */
export async function scheduleAlarm(
  state: AlarmGuardState,
  atMs: number,
  { floorMs = ALARM_FLOOR_MS, now = Date.now }: ScheduleAlarmOptions = {},
): Promise<number> {
  const at = Math.max(atMs, now() + floorMs);
  await state.storage.setAlarm(at);
  return at;
}

/** Options for {@link guardedAlarm}. */
export type GuardedAlarmOptions = {
  /** Names the alarm in logs and in its storage key; unique per Durable Object class. */
  key: string;
  /** The kill switch: pass {@link alarmsDisabled}`(env)`. */
  disabled?: boolean;
  /** Runs allowed per clock hour before the circuit opens. Defaults to 120. */
  maxPerHour?: number;
  /** Failure backoff: `min(baseMs * 2^(failures - 1), maxMs)`. Defaults to 30 s and 1 h. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Consecutive failures after which the guard stops re-arming. Defaults to 8. */
  maxConsecutiveFailures?: number;
  /**
   * While the circuit is open, re-arm once for the start of the next hour instead of leaving the
   * alarm off. Use it where an alarm that silently stops would lose work (a scheduler, a
   * keep-alive). Defaults to false.
   */
  deferWhenOpen?: boolean;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/** The guard's counters for one alarm: one small key, overwritten in place, never growing. */
export type AlarmGuardRecord = {
  /** Clock hour (`floor(ms / 1h)`) that `count` belongs to. */
  bucket: number;
  /** Runs started in `bucket`. */
  count: number;
  /** Consecutive failed runs; 0 after a success. */
  failures: number;
};

/** The delay before retry `failures` (1-based): `min(baseMs * 2^(failures - 1), maxMs)`. */
export function alarmBackoffMs(
  failures: number,
  { baseMs = 30_000, maxMs = HOUR_MS }: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = Math.max(baseMs, ALARM_FLOOR_MS);
  return Math.min(base * 2 ** Math.max(failures - 1, 0), Math.max(maxMs, base));
}

// This instance's view of each guarded alarm's counters. A loop keeps its Durable Object in
// memory, so the hourly count is exact without a write per run; storage takes over (see
// guardedAlarm) once a run fails or the count gets anywhere near the cap.
const seen = new WeakMap<AlarmGuardState, Map<string, AlarmGuardRecord>>();

/**
 * Wraps an `alarm()` body so it cannot loop:
 *
 * 1. With `disabled` (the `ALARMS_DISABLED` kill switch) it deletes the alarm, logs
 *    `alarm.disabled`, and returns without running `run`.
 * 2. It counts runs per clock hour. Past `maxPerHour` the circuit opens: it logs
 *    `alarm.circuit.open` once per hour at error level, skips `run`, and does not re-arm
 *    (or, with `deferWhenOpen`, re-arms for the next hour). The next hour closes it.
 * 3. If `run` throws, the guard owns the next alarm. It overrides whatever `run` armed with
 *    `now + backoff`, logs `alarm.failed`, and returns normally so the platform does not
 *    retry as well. A success resets the failure count.
 * 4. After `maxConsecutiveFailures` consecutive failures it deletes the alarm instead
 *    (`alarm.gave_up`). Only an outside re-arm, such as an RPC, runs it again, and the first
 *    success resets it.
 *
 * Cost: one KV read and at most one KV write per run. The counters live in one key
 * (`alarm-guard:<key>`), which is written only while the alarm is failing or has used more than
 * half its hourly budget, and is removed once neither holds. A healthy alarm therefore writes
 * nothing, and the guard stays invisible to code that lists or clears the object's own storage.
 * Counters are updated after `run`, so a run the runtime kills outright (CPU limit, eviction) is
 * not counted; the platform's own bounded retry covers that case.
 */
export async function guardedAlarm(
  state: AlarmGuardState,
  options: GuardedAlarmOptions,
  run: () => Promise<void>,
): Promise<void> {
  const { key, maxPerHour = 120, maxConsecutiveFailures = 8, now = Date.now } = options;
  const storage = state.storage;
  if (options.disabled) return halt(state, key);

  const storageKey = ALARM_GUARD_KEY_PREFIX + key;
  const bucket = Math.floor(now() / HOUR_MS);
  const stored = storage.kv.get<AlarmGuardRecord>(storageKey);
  let memory = seen.get(state);
  if (!memory) seen.set(state, memory = new Map());
  const remembered = memory.get(key);
  const previous = Math.max(
    stored?.bucket === bucket ? stored.count : 0,
    remembered?.bucket === bucket ? remembered.count : 0,
  );
  const failures = stored?.failures ?? 0;
  const count = previous + 1;
  memory.set(key, { bucket, count, failures });

  if (count > maxPerHour) {
    if (previous <= maxPerHour) {
      logger.error("alarm circuit open: too many runs this hour", {
        event: "alarm.circuit.open", alarmKey: key, count, maxPerHour,
      });
      storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures });
    }
    if (options.deferWhenOpen) await storage.setAlarm((bucket + 1) * HOUR_MS);
    return;
  }

  let nextFailures = 0;
  try {
    await run();
  } catch (error) {
    nextFailures = failures + 1;
    if (nextFailures >= maxConsecutiveFailures) {
      await storage.deleteAlarm();
      logger.error("alarm gave up after consecutive failures", {
        event: "alarm.gave_up", alarmKey: key, failures: nextFailures, error,
      });
    } else {
      const retryAt = now() + alarmBackoffMs(nextFailures, options.backoff);
      await storage.setAlarm(retryAt);
      logger.error("alarm failed; retrying with backoff", {
        event: "alarm.failed", alarmKey: key, failures: nextFailures, retryAt, error,
      });
    }
  }
  const record: AlarmGuardRecord = { bucket, count, failures: nextFailures };
  memory.set(key, record);
  if (nextFailures > 0 || count > maxPerHour / 2) storage.kv.put(storageKey, record);
  else if (stored) storage.kv.delete(storageKey);
}
