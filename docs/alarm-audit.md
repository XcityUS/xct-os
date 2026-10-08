# Durable Object alarm audit

**Why this exists.** One Cloudflare customer got a bill of about $10,000 after a Durable Object
`alarm()` went into a loop. Each run failed, re-armed itself immediately, and failed again,
until the loop had done about 6 trillion storage reads and writes. Cloudflare has no hard spend
cap, so this repository has to make that failure impossible itself. This document lists every
alarm in `packages/` and how it fails. It gives each one a verdict, and it ends with the rules
new alarm code must follow.

How Cloudflare handles a failed alarm:

- When `alarm()` throws, the runtime retries it with exponential backoff, starting at about 2 s
  and stopping after about 6 retries.
- A `setAlarm()` call made during the handler (including in its `finally`) arms a new alarm.
  That alarm fires at the time it names, whether or not the handler then throws, so a handler
  that re-arms at `now` skips the platform backoff.
- An alarm whose time is already past fires almost at once. "Re-arm at a past or present time"
  therefore means "loop as fast as the runtime can schedule".

Audited at `origin/main` 2026-10-08 with
`git grep -n "setAlarm\|getAlarm\|deleteAlarm\|async alarm(\|alarm()" -- packages`. The search
found 19 `alarm()` handlers in 17 files. Generated `worker-configuration.d.ts` typings, tests and
comments were excluded. Line numbers are from that commit.

Verdicts:

- **SAFE**: cannot loop, or re-arms only at a bounded, low rate.
- **NEEDS-BACKOFF**: retries forever at a fixed cadence.
- **NEEDS-CIRCUIT-BREAKER**: a permanent failure re-runs forever.
- **BUG**: a reachable state re-arms at `now` or in the past, so it spins.

## Summary

| Verdict | Count | Sites |
|---|---|---|
| BUG | 2 | S1 scheduler poison row, O1 overseer undeliverable external response |
| NEEDS-BACKOFF | 2 | S2 scheduler admission re-lease, O2 overseer pending-call drain (low; documented, not changed) |
| NEEDS-CIRCUIT-BREAKER | 1 | S3 scheduler handler failing permanently |
| SAFE | 16 handlers | the 12 OAuth/connect timeouts, xcity ×2, mcp-shared, PendingLogin, UserDurableObject handoff sweep |

## Table

"Re-arm" columns:

- **unconditional?** asks whether the handler arms itself at `now`, or at a small constant
  interval, regardless of what happened.
- **depends on self-advanced state?** asks whether the next alarm time comes from state that the
  handler itself is supposed to move forward. If so, a stuck item means the loop never ends.

### Connect-flow timeouts (gatekeepers + mcp-shared)

These handlers share one pattern. `setCallback()` arms a one-shot alarm 1 h ahead, and only when
the account is not connected yet. A successful `complete()` and `revoke()` delete the alarm.
When the alarm fires, the handler calls `deleteAll()` if the flow never finished, and never
re-arms.

| Handler | Armed by | Handler does | If it throws | Re-arm unconditional? | Depends on self-advanced state? | Worst-case rate / ops per run | Verdict |
|---|---|---|---|---|---|---|---|
| `gatekeeper-cloudflare/src/cloudflare.ts:431` | `:230` setCallback (+1 h), `:336` auth-only grant (+2 min); deleted `:440` | `deleteAll()` if no refresh token or ephemeral | platform retries ≤6, then drops | no (never re-arms) | no | 1 per connect attempt; 1 read + 1 `deleteAll` | SAFE |
| `gatekeeper-confluence/src/confluence.ts:427` | `:285` (+1 h); deleted `:432` | `deleteAll()` if no grant | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-email/src/email.ts:329` | `:295` (+1 h, every setCallback); deleted `:323` on complete | unconditional `deleteAll()` | retry ≤6 | no | no | 1 per attempt | SAFE (note: deletes claimed e-mails if a completed account re-enters setCallback and abandons; not a loop) |
| `gatekeeper-github/src/github.ts:1523` | `:1389` (+1 h), `:1480` ephemeral (+2 min); deleted `:1485`, `:1543` | `deleteAll()` if no token or ephemeral | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-google/src/google.ts:696` | `:437` (+1 h), `:557` auth mode (+2 min); deleted `:559`, `:710` | under the credentials lock, `deleteAll()` if `shouldDeleteCredentialsOnAlarm` | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-homeassistant/src/homeassistant.ts:537` | `:410` (+1 h); deleted `:499`, `:544` | `deleteAll()` if no credentials | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-linear/src/linear.ts:671` | `:529` (+1 h); deleted `:612`, `:689` | `deleteAll()` if no grant | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-notion/src/notion.ts:482` | `:328` (+1 h); deleted `:489` | `deleteAll()` if no token | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-slack/src/slack.ts:514` | `:338` (+1 h); deleted `:526` | `deleteAll()` if no token | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-spotify/src/spotify.ts:652` | `:511` (+1 h); deleted `:596`, `:661` | `deleteAll()` if no refresh token | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-supabase/src/supabase.ts:565` | `:403` (+1 h); deleted `:490`, `:582` | `deleteAll()` if no refresh token | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-zoominfo/src/zoominfo.ts:552` | `:383` (+1 h); deleted `:489`, `:561` | `deleteAll()` if no refresh token | retry ≤6 | no | no | 1 per attempt | SAFE |
| `gatekeeper-xcity/src/xcity.ts:524` (`UserAccount`) | `:318` (+1 h), `:420` ephemeral (+2 min); deleted `:533` | `deleteAll()` if no refresh token or ephemeral | retry ≤6 | no | no | 1 per attempt | SAFE |
| `mcp-shared/src/account.ts:1095` | `:280` (+1 h, first connect only); deleted `:878`, `:1109` | `deleteAll()` unless `connected` | retry ≤6 | no | no | 1 per attempt | SAFE |

`setCallback` is an RPC that a client can call repeatedly. Each call only moves the one alarm to
a time 1 h ahead, so repeated calls cannot create a loop.

### Polling and sweeps

| Handler | Armed by | Handler does | If it throws | Re-arm unconditional? | Depends on self-advanced state? | Worst-case rate / ops per run | Verdict |
|---|---|---|---|---|---|---|---|
| `gatekeeper-xcity/src/xcity.ts:1154` (`XcityMediaGatekeeperImpl`) | `:964` `#setVideoAlarm` (+10 s), from `#startVideo` (approved action) and the handler | polls each `media:video:*` flight; each poll catches its own error and writes `updatedAt`; re-arms +10 s while any flight remains | retry ≤6, then drops (stuck flights stay "processing"; a liveness issue, not a cost issue) | yes, +10 s while flights exist | yes, but every flight has a hard `deadlineAt` (30 min) after which it is stored as failed and removed | ≤360/h per DO and only during a flight's 30 min; per run: 1 list + per flight 1 outbound fetch + 1–2 writes | SAFE (bounded by deadline; 10 s floor) |
| `workshop-backend/src/auth/login-flow.ts:175` (`PendingLogin`) | `:112` `#store` (begin/deliver/fail, at `expiresAt`); deleted `:172` | deletes the result key | retry ≤6 | no | no | 1 per sign-in; 1 delete | SAFE |
| `workshop-backend/src/user.ts:2287` (`UserDurableObject`) | `:2277/2279` `#armHandoffSweep` (soonest pending expiry), from `:2145`, `:2159`, the handler `:2308` | deletes expired connect flows and handoffs, revokes abandoned connects (best effort, caught), re-arms at the next expiry | retry ≤6 | no: only at a future expiry; if a stub fails to deserialize, at `now + PENDING_HANDOFF_LIFETIME_MS` (2 min) | yes. Expired rows are deleted before re-arming, and the poison-stub fallback is time-floored | normally 1 per expiry; with a poison stub record, 30/h until the Worker is bound again (a few list reads + 1 warn log each) | SAFE (low-rate residual: the poison record cannot be deleted; follow-up) |

### Scheduler (`gatekeeper-scheduler/src/schedule-driver.ts`, `ScheduleDriver`)

The scheduler has one alarm per account. `#planAlarm` sets it to the earliest `alarmTarget()` of
all schedule rows: `nextFire`, `nextAttempt` or `leaseExpiresAt`.

| Site | Armed by / does | If it throws | Re-arm unconditional? | Depends on self-advanced state? | Worst-case rate / ops per run | Verdict |
|---|---|---|---|---|---|---|
| `:237` `alarm()` → `#runAlarm` `:266` | arms recovery `now+5 min` first (`:273`), then delivers ≤20 due rows (4 concurrently) and calls `#planAlarm` | logs, `reportIssue`, rethrows; the recovery alarm (+5 min) is already armed | yes, the +5 min watchdog | see S1–S3 | see S1–S3 | **S1 BUG / S2 NEEDS-BACKOFF / S3 NEEDS-CIRCUIT-BREAKER** |
| `:549` `#planAlarm` (`:552`, `:561`, `:562`) | `setAlarm(min target)`, which may be in the past; `setAlarm(Date.now())` when revoked | propagates | **yes when revoked (`now`)**; the target is in the past whenever a due row was not advanced | **yes**: the target comes from row state that delivery is supposed to advance | see S1 | BUG (S1) |
| `:313` `#armRecoveryAlarm` (`:315`, `:316`) | from `enable()`: arms `now+5 min` if nothing earlier is armed | throws to the caller | no | no | 1 per enable | SAFE |
| `:213` `revoke()` (`:216`) | RPC: `setAlarm(Date.now())` before marking the account revoked | throws to the caller | `now`, but driven by the caller | no | 1 per call; a client that calls it repeatedly only re-arms the same one alarm | SAFE (rule violation `setAlarm(now)`; now floored) |
| `:565` `#cleanupRevokedAccount` (`:579`, `:580`) | deletes ≤100 rows per run; `setAlarm(Date.now())` while rows remain | throws; recovery +5 min | **yes (`now`)** | yes, but each run deletes 100 rows atomically, so it always makes progress | ≤ rows/100 runs (≤ 11 for a full account), 101 reads + ≤100 deletes each | SAFE (bounded by progress; now floored) |

### Overseer (`workshop-backend/src/overseer.ts`, `OverseerDurableObject`)

| Site | Armed by / does | If it throws | Re-arm unconditional? | Depends on self-advanced state? | Worst-case rate / ops per run | Verdict |
|---|---|---|---|---|---|---|
| `:9957` `alarm()` → `runAlarmTasks` `:1875` | waits for running agents, drains pending agent calls, delivers ready external-message responses; the `finally` calls `#updateAlarm` | the delivery failure is rethrown **after** `finally` has already re-armed | see O1 | see O1/O2 | see O1/O2 | **O1 BUG / O2 NEEDS-BACKOFF** |
| `:1830` `#updateAlarm` (`:1859`, `:1861`) | only writer; earliest of keep-alive (+60 s), **`Date.now()` if any `ready` external response exists**, delivered-record sweep (+24 h); called from 9 sites (RPC paths, `waitUntil`) | n/a | **yes: `Date.now()` while any ready record exists** | **yes**: the ready record should become `delivered`, which never happens if the target keeps failing | see O1 | BUG (O1) |

## Findings (non-SAFE)

### S1: scheduler poison row spins the alarm (BUG)

`schedule-driver.ts:376` `#deliver` → `:478` `#prepareRun` → transition → `:549` `#planAlarm`.

Scenario:

1. A schedule row is due, and its state transition throws. For a lease-expired `pending/delivery`
   row, `#prepareRun` calls `failRun` (`driver-state.ts:166`). That calls `recurringNextFire` →
   `nextFireAfter` (`scheduler-core.ts:163`), which re-validates the stored spec through
   `assertValidSpec`. It throws for any stored row the current code no longer accepts: an
   interval below a raised `MIN_INTERVAL_MS`, a timezone the runtime's ICU no longer knows, or a
   `checkedTimestamp` overflow.
2. The exception is caught and reported per row (`#deliverSafely` `:455`), so the batch
   "succeeds" without writing anything for that row.
3. `#planAlarm` then computes the row's unchanged `leaseExpiresAt`, which is in the past, and
   calls `setAlarm(past)`. The alarm fires immediately and repeats forever.

Each iteration does about 2× the account's schedule rows in reads (≤500 each), 2 alarm writes, one
`reportIssue` dispatch and one error log. The rate is limited only by how fast the runtime can
reschedule: many per second, around the clock, per affected account. This is the incident
pattern.

**Fix:**

- `#deliverSafely` and `#deliver` now quarantine a row whose delivery throws unexpectedly: it is
  marked `dead` in one transaction, and its capability is released. The row can never be due
  again, and the user sees it as dead in the management UI.
- `#planAlarm`, `revoke` and the revoked cleanup arm through `scheduleAlarm`, which floors the
  alarm time at `now + 1 s`.
- The handler is wrapped in `guardedAlarm`. Regression test: `schedule-driver.test.ts`, "a row
  whose transition throws is quarantined instead of spinning the alarm".

### S2: scheduler admission re-lease retries forever (NEEDS-BACKOFF)

Same handler. A `pending/admission` row whose `#markAdmitted` → `admitRun` → `recurringNextFire`
throws, or whose `#settle` transition throws, stays `pending`, with its lease pushed 5 min out.
Every 5 min `#prepareRun` re-leases it and calls the workshop's `startHook()` again. That is about
12 outbound RPCs per hour, forever, with an error report each time. **Fix:** the same quarantine
as S1, so the first unexpected failure ends it.

### S3: scheduler handler failing permanently (NEEDS-CIRCUIT-BREAKER)

Corrupt driver metadata makes `#requireMetadata` throw, as does any deterministic failure before
or inside `#planAlarm`. The handler then throws on every run. The +5 min recovery alarm armed at
the top of `#runAlarm` keeps it alive forever: 288 runs a day, each followed by up to 6
platform retries, each with an error report. **Fix:** `guardedAlarm` (key `scheduler`,
`maxPerHour: 3600`, `deferWhenOpen: true`). It catches the failure, takes over the next alarm
with 30 s → 1 h exponential backoff, and gives up after 8 consecutive failures. A later
`enable`/`disable` re-arms it.

### O1: overseer undeliverable external response re-arms at `now` (BUG)

`overseer.ts:7053` `deliverReadyExternalMessageResponses`, `:1875` `runAlarmTasks`, `:1830`
`#updateAlarm`.

Scenario:

1. A chat gateway's persisted `chatGatewayRpcTarget` fails on every call. For example, the
   gateway's Worker was removed, or it rejects the payload.
2. The record stays `status: "ready"`. `runAlarmTasks` rethrows the failure, but its `finally`
   has already called `#updateAlarm`, which pushes `Date.now()` because a ready record exists.
3. The new alarm fires immediately and the delivery fails again, forever.

Even if the platform's retry backoff did apply, every other `#updateAlarm` call would re-arm at
`now`. Those calls include each agent turn starting or ending, and the `waitUntil` delivery's
`finally`.

Each iteration does about 5–10 index reads, 1 alarm write, 1 outbound RPC and 1 error log, as
fast as the runtime reschedules, per affected workspace.

**Fix:**

- Ready records count `deliveryAttempts`. After `MAX_RESPONSE_DELIVERY_ATTEMPTS` (8) the record is
  settled as `delivered`, which keeps it idempotent, and an error is logged rather than the
  failure being rethrown.
- `alarm()` is wrapped in `guardedAlarm` (key `overseer`, `maxPerHour: 1200`,
  `deferWhenOpen: true`), which replaces the `now` re-arm with backoff when the handler throws.
- Regression test: `agent-calls.test.ts`, "an undeliverable external response stops re-arming
  the alarm".

### O2: overseer pending-call drain retries every 60 s (NEEDS-BACKOFF, low; not changed)

`#drainPendingAgentCalls` (`overseer.ts:7528`) catches its own failures. If the initiator's user
DO keeps failing, the calls stay recorded, and `#updateAlarm` re-arms the keep-alive at
`now + 60 s` forever. That is 60 runs/h, each doing a few reads and 1 RPC; the rate is bounded
and the cost small. Fixing it needs per-call attempt state in kernel storage, so it is left as a
follow-up. The kill switch and the hourly cap still cover it.
