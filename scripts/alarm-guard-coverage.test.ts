import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every Durable Object `alarm()` must be stoppable with the `ALARMS_DISABLED` kill switch (see
 * docs/alarm-audit.md): a runaway alarm has no hard spend cap behind it on Cloudflare, so the
 * emergency stop has to work everywhere, including handlers that arrive in an upstream sync.
 *
 * A source file that defines `async alarm(` must reference the alarm guard (`haltIfAlarmsDisabled`,
 * `guardedAlarm`, or `alarmsDisabled`). This checks the file, not each class, so a file with
 * several handlers needs the guard in each by convention; the audit table is where that is
 * reviewed. Adding a handler without the guard fails here instead of shipping unstoppable.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = /\b(haltIfAlarmsDisabled|guardedAlarm|alarmsDisabled)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated" || name === ".wrangler") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("Durable Object alarm kill switch", () => {
  it("is present in every source file that defines an alarm() handler", () => {
    const packagesDir = join(repoRoot, "packages");
    const unguarded: string[] = [];
    let handlers = 0;
    for (const pkg of readdirSync(packagesDir)) {
      const src = join(packagesDir, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        const text = readFileSync(file, "utf8");
        const count = text.match(/\basync alarm\(/g)?.length ?? 0;
        if (count === 0) continue;
        handlers += count;
        if (!GUARD.test(text)) unguarded.push(file.slice(repoRoot.length + 1));
      }
    }
    assert.ok(handlers > 0, "found no alarm() handlers; the scan is broken");
    assert.deepEqual(
      unguarded, [],
      "alarm() without the ALARMS_DISABLED kill switch (use haltIfAlarmsDisabled/guardedAlarm from " +
        "@gadgets/observability/alarm-guard, and add the handler to docs/alarm-audit.md)",
    );
  });
});
