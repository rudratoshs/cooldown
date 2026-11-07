// Cooldown — pure signal logic (no camera, no SDK, fully unit-testable).
// The gate's only job: decide when a heated message may be released, based on
// the user's OWN baseline, using confident/stable live readings — never on an
// inferred emotional or medical state.

export const DEFAULT_CFG = {
  // a reading only counts if the SDK marks it stable AND confidence >= min
  pulseMinConf: 70, // pulse hit 99.5% in validation; 70 is a safe trust floor
  breathingMinConf: 55, // breathing hit 83%; 55 trust floor
  // "eased" means at or below the personal baseline plus a small margin
  pulseMargin: 2, // bpm above baseline still counts as eased
  breathingMargin: 1.5, // breaths/min above baseline still counts as eased
  // how long both signals must stay eased, continuously, before unlock
  holdMs: 15000,
  // a floor so the pause is always meaningful even if the body settles fast
  minPauseMs: 60000,
  // baseline calibration needs at least this many clean samples of each signal
  minBaselineSamples: 5,
  // breathing readings are sparse; require a few more before trusting the median
  minBreathingSamples: 6,
  // a freak-low calibration shouldn't make the gate unsatisfiable: floor the
  // resting breathing baseline to a physiologically plausible minimum
  breathingBaselineFloor: 9,
};

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// A reading is trustworthy only when the SDK says stable and confidence clears
// the floor. Everything else is treated as "no reading", never as a calm signal.
export function readingTrusted(r, minConf) {
  return !!(r && r.stable === true && typeof r.value === "number" && Number(r.confidence) >= minConf);
}

// Build a personal baseline from calibration samples. Returns null (refuse to
// proceed) when there are too few clean samples — never invents a baseline.
export function buildBaseline(pulseReadings, breathingReadings, cfg = DEFAULT_CFG) {
  const p = pulseReadings.filter((r) => readingTrusted(r, cfg.pulseMinConf)).map((r) => r.value);
  const b = breathingReadings.filter((r) => readingTrusted(r, cfg.breathingMinConf)).map((r) => r.value);
  if (p.length < cfg.minBaselineSamples || b.length < (cfg.minBreathingSamples ?? cfg.minBaselineSamples)) {
    return null;
  }
  const breathingBpm = Math.max(median(b), cfg.breathingBaselineFloor ?? 0);
  return { pulseBpm: median(p), breathingBpm, pulseSamples: p.length, breathingSamples: b.length };
}

// Classify the latest readings against the baseline. "Eased" requires a trusted
// reading at or below baseline+margin. An untrusted/absent reading is NOT eased.
export function classifyReading(latest, baseline, cfg = DEFAULT_CFG) {
  const pulseTrusted = readingTrusted(latest.pulse, cfg.pulseMinConf);
  const breathingTrusted = readingTrusted(latest.breathing, cfg.breathingMinConf);
  const pulseOk = pulseTrusted && latest.pulse.value <= baseline.pulseBpm + cfg.pulseMargin;
  const breathingOk = breathingTrusted && latest.breathing.value <= baseline.breathingBpm + cfg.breathingMargin;
  return { pulseTrusted, breathingTrusted, pulseOk, breathingOk, bothOk: pulseOk && breathingOk };
}

// Tracks, over time, whether both signals have stayed eased continuously long
// enough, and whether the minimum pause has elapsed. Manual override is handled
// by the caller — the body-gate never permanently blocks a message on its own.
export class GateTracker {
  constructor(startedAt, cfg = DEFAULT_CFG) {
    this.startedAt = startedAt;
    this.cfg = cfg;
    this.calmSince = null;
  }
  update(now, latest, baseline) {
    const c = classifyReading(latest, baseline, this.cfg);
    if (c.bothOk) {
      if (this.calmSince == null) this.calmSince = now;
    } else {
      this.calmSince = null; // any break resets the hold
    }
    const heldMs = this.calmSince == null ? 0 : now - this.calmSince;
    const minPauseMet = now - this.startedAt >= this.cfg.minPauseMs;
    const unlocked = minPauseMet && heldMs >= this.cfg.holdMs;
    return { ...c, heldMs, minPauseMet, unlocked, elapsedMs: now - this.startedAt };
  }
}
