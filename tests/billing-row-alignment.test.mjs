import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(
  root,
  "patches/dashboard-v0.20/overlay/packages/client/src/components/settings/BillingStatsSection.tsx",
);
const source = fs.readFileSync(file, "utf8");
const amountClass = source.match(/const entryAmountClass\s*=\s*"([^"]+)"/)?.[1];

test("billing entries pin their cost column right with tabular figures", () => {
  assert.ok(amountClass, "entryAmountClass must exist");
  const tokens = amountClass.split(/\s+/);
  for (const token of [
    "shrink-0",
    "text-right",
    "font-mono",
    "text-sm",
    "tabular-nums",
  ])
    assert.ok(tokens.includes(token), `amount class is missing ${token}`);
  assert.ok(!tokens.includes("text-left"), "amounts must not be left-aligned");
});

test("all three per-entry views use the shared right-aligned amount class", () => {
  const uses = source.match(/className=\{entryAmountClass\}/g) ?? [];
  assert.equal(uses.length, 3, "directory, session and model rows each need one");
  for (const row of ["billing-directory-row", "billing-session-row", "billing-model-row"]) {
    const start = source.indexOf(`data-testid="${row}"`);
    assert.notEqual(start, -1, `${row} must render`);
    const end = source.indexOf("data-testid=", start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    assert.match(block, /className=\{entryAmountClass\}/, `${row} amount must use entryAmountClass`);
  }
});

test("session and model breakdown lines use tabular figures without disabling wrapping", () => {
  const breakdowns =
    source.match(/mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-\[var\(--text-tertiary\)\]/g) ??
    [];
  assert.equal(breakdowns.length, 2, "session and model metadata rows must stay tabular");
  assert.ok(
    source.includes("flex min-w-0 items-center gap-3"),
    "directory rows must keep the existing mobile flex layout",
  );
  assert.ok(
    source.match(/flex min-w-0 items-start gap-3/g)?.length === 2,
    "session and model rows must keep the existing mobile flex layout",
  );
  assert.ok(!/entryAmountClass[^\n]*whitespace-nowrap/.test(source));
});
