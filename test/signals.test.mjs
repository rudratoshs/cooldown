import { test } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  readingTrusted,
  buildBaseline,
  classifyReading,
  GateTracker,
  DEFAULT_CFG,
} from "../signals.mjs";

const pulse = (value, confidence = 99, stable = true) => ({ value, confidence, stable });
const breath = (value, confidence = 80, stable = true) => ({ value, confidence, stable });

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("readingTrusted: needs stable + confidence + numeric value", () => {
  assert.equal(readingTrusted(pulse(60, 90, true), 70), true);
  assert.equal(readingTrusted(pulse(60, 50, true), 70), false); // low confidence
  assert.equal(readingTrusted(pulse(60, 90, false), 70), false); // not stable
  assert.equal(readingTrusted(null, 70), false);
  assert.equal(readingTrusted({ confidence: 99, stable: true }, 70), false); // no value
});

test("buildBaseline: refuses on too few clean samples, else medians", () => {
  const few = buildBaseline([pulse(60), pulse(61)], [breath(14), breath(15)]);
  assert.equal(few, null, "fewer than minBaselineSamples -> null (never invents)");

  const p = [58, 60, 62, 59, 61].map((v) => pulse(v));
  const b = [14, 15, 13, 16, 14, 14].map((v) => breath(v)); // needs >= minBreathingSamples (6)
  const base = buildBaseline(p, b);
  assert.equal(base.pulseBpm, 60);
  assert.equal(base.breathingBpm, 14);

  // too few breathing samples -> refuse
  assert.equal(buildBaseline(p, [14, 15, 13, 16, 14].map((v) => breath(v))), null, "5 breathing < 6 -> null");

  // low-confidence samples are excluded from the baseline
  const noisy = buildBaseline(
    [pulse(60, 30), pulse(61, 30), pulse(62, 30), pulse(59, 30), pulse(58, 30)],
    b,
  );
  assert.equal(noisy, null, "all low-confidence pulse -> cannot baseline");
});

test("buildBaseline: floors a freak-low breathing median to a plausible resting rate", () => {
  const p = [58, 60, 62, 59, 61].map((v) => pulse(v));
  const slow = [6, 7, 7, 6, 8, 7].map((v) => breath(v)); // median 7 -> floored to 9
  const base = buildBaseline(p, slow);
  assert.equal(base.breathingBpm, 9, "baseline floored so the gate stays satisfiable");
});

test("classifyReading: eased only when trusted AND <= baseline+margin", () => {
  const baseline = { pulseBpm: 60, breathingBpm: 14 };
  // both at baseline -> eased
  let c = classifyReading({ pulse: pulse(60), breathing: breath(14) }, baseline);
  assert.equal(c.bothOk, true);
  // pulse elevated beyond margin -> not eased
  c = classifyReading({ pulse: pulse(80), breathing: breath(14) }, baseline);
  assert.equal(c.pulseOk, false);
  assert.equal(c.bothOk, false);
  // within margin -> still eased
  c = classifyReading({ pulse: pulse(62), breathing: breath(15.5) }, baseline);
  assert.equal(c.bothOk, true);
  // low-confidence "calm" reading must NOT count as eased
  c = classifyReading({ pulse: pulse(55, 20), breathing: breath(12, 20) }, baseline);
  assert.equal(c.pulseOk, false);
  assert.equal(c.breathingOk, false);
});

test("GateTracker: needs minPause AND continuous hold; a break resets hold", () => {
  const baseline = { pulseBpm: 60, breathingBpm: 14 };
  const cfg = { ...DEFAULT_CFG, minPauseMs: 10000, holdMs: 5000 };
  const calm = { pulse: pulse(58), breathing: breath(13) };
  const heated = { pulse: pulse(95), breathing: breath(22) };
  const g = new GateTracker(0, cfg);

  // calm from the start, but minPause (10s) not yet met -> locked
  let r = g.update(3000, calm, baseline);
  assert.equal(r.bothOk, true);
  assert.equal(r.unlocked, false, "held long enough can't matter before minPause");

  // a heated reading mid-way resets the calm hold
  r = g.update(8000, heated, baseline);
  assert.equal(r.heldMs, 0, "break resets hold");

  // calm resumes at 9s; by 13s hold=4s (<5s) and minPause met -> still locked
  g.update(9000, calm, baseline);
  r = g.update(13000, calm, baseline);
  assert.equal(r.minPauseMet, true);
  assert.equal(r.unlocked, false, "hold not yet 5s");

  // by 14s hold=5s and minPause met -> unlock
  r = g.update(14000, calm, baseline);
  assert.equal(r.unlocked, true);
});

test("GateTracker: staying heated never unlocks (override is the only out)", () => {
  const baseline = { pulseBpm: 60, breathingBpm: 14 };
  const cfg = { ...DEFAULT_CFG, minPauseMs: 1000, holdMs: 1000 };
  const g = new GateTracker(0, cfg);
  const heated = { pulse: pulse(100), breathing: breath(24) };
  let r;
  for (let t = 500; t <= 120000; t += 500) r = g.update(t, heated, baseline);
  assert.equal(r.unlocked, false, "body-gate alone never forces a send");
});
