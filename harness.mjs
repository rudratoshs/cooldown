// Cooldown — Phase 1 signal-validation harness (diagnostic build).
// Proves the SmartSpectra SDK streams pulse / breathing / HRV on THIS webcam and
// learns the EXACT decoded metric shape, before any UI is built.
//
// Writes small local files (safe to read; metrics only, never the key, never frames):
//   schema-first.json  — full decoded packet, first emit
//   schema-late.json   — full decoded packet near the end (after all windows fill)
//   phase1-report.json — validation-code tally + auto-discovered metric field paths/values
//
// Run:  cd cooldown && npm start
// macOS will prompt your terminal for camera access the first time — allow it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SECONDS = 90;
const out = (name) => join(HERE, name);

// ---- resolve the API key without ever logging it -------------------------
function loadKey() {
  if (process.env.PRESAGE_API_KEY?.trim()) return process.env.PRESAGE_API_KEY.trim();
  for (const p of [join(HERE, "presage.key"), join(HERE, "..", "presage.key")]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {}
  }
  return null;
}
const apiKey = loadKey();
if (!apiKey) {
  console.error("No API key (cooldown/presage.key, sendora/presage.key, or PRESAGE_API_KEY).");
  process.exit(1);
}

// ---- import SDK ----------------------------------------------------------
let SDK, messages;
try {
  SDK = await import("@smartspectra/node-sdk");
  messages = await import("@smartspectra/node-sdk/messages");
} catch (e) {
  console.error("Failed to import SDK:", e?.message || e);
  process.exit(1);
}
const {
  SmartSpectraSDK,
  CameraSelection,
  ValidationCode,
  cardioMetrics = [],
  breathingMetrics = [],
  faceMetrics = [],
} = SDK;
const decodeMetrics = messages.decodeMetrics;

// readable name for a validation code, if the SDK exposes the enum
const vcodeName = {};
if (ValidationCode && typeof ValidationCode === "object") {
  for (const [k, v] of Object.entries(ValidationCode)) if (typeof v === "number") vcodeName[v] = k;
}

// ---- deep discovery: find numeric leaves + their dotted paths ------------
// Follows the LAST element of any array (metrics come as windows of samples).
function discover(node, path, acc, depth = 0) {
  if (node == null || depth > 8) return;
  if (typeof node === "number") {
    if (Number.isFinite(node)) acc.push([path, node]);
    return;
  }
  if (typeof node === "bigint") {
    acc.push([path, Number(node)]);
    return;
  }
  if (typeof node === "boolean") {
    acc.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length) discover(node[node.length - 1], `${path}[last/${node.length}]`, acc, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "function") continue;
      discover(v, path ? `${path}.${k}` : k, acc, depth + 1);
    }
  }
}
const INTEREST = /pulse|rate|hrv|rmssd|sdnn|mean|baevsky|breath|bpm|conf|stable|strain|value/i;

// ---- state ---------------------------------------------------------------
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5);
let emits = 0,
  decodeFails = 0,
  lastPrint = 0,
  wroteFirst = false;
let latestPacket = null;
const vtally = {};
const processingSeen = new Set();

// Explicit per-signal trackers across the WHOLE run (not just last packet).
function tracker() {
  return { count: 0, firstSeenS: null, lastValue: null, maxConfidence: null, lastRaw: null };
}
const track = { pulseRate: tracker(), breathingRate: tracker(), hrv: tracker() };
function note(t, value, confidence, raw) {
  t.count++;
  if (t.firstSeenS == null) t.firstSeenS = Number(elapsed());
  if (value != null) t.lastValue = value;
  if (confidence != null) t.maxConfidence = Math.max(t.maxConfidence ?? 0, confidence);
  if (raw) t.lastRaw = raw;
}
const pick = (e, keys) => {
  for (const k of keys) if (e && e[k] != null) return e[k];
  return null;
};

function safeStringify(o) {
  return JSON.stringify(o, (k, v) => (typeof v === "bigint" ? Number(v) : v), 2);
}

// ---- construct + wire ----------------------------------------------------
const sdk = new SmartSpectraSDK({
  apiKey,
  requestedMetrics: [...new Set([...cardioMetrics, ...breathingMetrics, ...faceMetrics])],
  enableTelemetry: false,
});

sdk.on("metrics", (buf) => {
  let m;
  try {
    m = decodeMetrics(buf);
  } catch (e) {
    decodeFails++;
    return;
  }
  emits++;
  latestPacket = m;

  // explicit gate-signal tracking across the whole run
  const cardio = m.cardio ?? {};
  const breathing = m.breathing ?? {};
  for (const e of Array.isArray(cardio.pulseRate) ? cardio.pulseRate : []) {
    note(track.pulseRate, pick(e, ["value", "pulseRate", "rate", "bpm"]), pick(e, ["confidence", "conf"]), e);
  }
  for (const e of Array.isArray(breathing.rate) ? breathing.rate : []) {
    note(track.breathingRate, pick(e, ["value", "rate", "breathingRate", "bpm"]), pick(e, ["confidence", "conf"]), e);
  }
  for (const e of Array.isArray(cardio.hrv) ? cardio.hrv : []) {
    note(track.hrv, e?.rmssd ?? null, pick(e, ["confidence", "conf"]), e);
  }

  if (!wroteFirst) {
    wroteFirst = true;
    try {
      writeFileSync(out("schema-first.json"), safeStringify(m).slice(0, 20000));
      console.log(`[${elapsed()}s] wrote schema-first.json (top keys: ${Object.keys(m).join(", ")})`);
    } catch (e) {
      console.log("could not write schema-first.json:", e?.message || e);
    }
  }

  // throttle console to ~1 line / 2s, showing discovered interesting values
  const now = Date.now();
  if (now - lastPrint >= 2000) {
    lastPrint = now;
    const acc = [];
    discover(m, "", acc);
    const hits = acc.filter(([p]) => INTEREST.test(p)).slice(0, 6);
    console.log(
      `[${elapsed()}s] emit#${emits}  ${hits.map(([p, v]) => `${p.split(".").slice(-2).join(".")}=${v}`).join("  ") || "(no numeric fields yet)"}`,
    );
  }
});

sdk.on("validationStatus", (code, ts, hint) => {
  const name = vcodeName[code] ?? code;
  vtally[name] = (vtally[name] || 0) + 1;
});
sdk.on("processingStatus", (status) => processingSeen.add(String(status)));
sdk.on("error", (code, message, retryable) =>
  console.log(`[${elapsed()}s] ERROR code=${code} retryable=${retryable} — ${message}`),
);

// ---- lifecycle -----------------------------------------------------------
async function shutdown(reason) {
  console.log(`\nStopping (${reason})…`);
  try { await sdk.stopAsync?.(); } catch {}
  try { await sdk.destroy?.(); } catch {}

  // late snapshot + discovered fields
  const acc = [];
  if (latestPacket) discover(latestPacket, "", acc);
  const interesting = acc.filter(([p]) => INTEREST.test(p));
  const report = {
    runSeconds: RUN_SECONDS,
    metricsPackets: emits,
    decodeFailures: decodeFails,
    processingStatesSeen: [...processingSeen],
    validationTally: vtally,
    gateSignals: {
      pulseRate: track.pulseRate,
      breathingRate: track.breathingRate,
      hrv: track.hrv,
    },
    latePacketTopKeys: latestPacket ? Object.keys(latestPacket) : [],
    discoveredFields: interesting.map(([path, value]) => ({ path, value })),
  };
  try {
    writeFileSync(out("phase1-report.json"), safeStringify(report));
    if (latestPacket) writeFileSync(out("schema-late.json"), safeStringify(latestPacket).slice(0, 20000));
  } catch (e) {
    console.log("could not write report:", e?.message || e);
  }

  const g = (t, label) =>
    `${label.padEnd(14)}: ${t.count > 0 ? "SEEN" : "NOT SEEN"}  count=${t.count}  first=${t.firstSeenS ?? "-"}s  last=${t.lastValue ?? "-"}  maxConf=${t.maxConfidence ?? "-"}`;
  console.log("\n================= PHASE 1 SUMMARY =================");
  console.log(`metrics packets        : ${emits}`);
  console.log(`decode failures        : ${decodeFails}`);
  console.log(`validation tally       : ${safeStringify(vtally)}`);
  console.log("--- gate signals (whole run) ---");
  console.log("  " + g(track.pulseRate, "pulseRate"));
  console.log("  " + g(track.breathingRate, "breathingRate"));
  console.log("  " + g(track.hrv, "hrv(rmssd)"));
  console.log("wrote: schema-first.json, schema-late.json, phase1-report.json");
  console.log("==================================================");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`\nStarting camera. Face it, even light, head+upper chest in frame, fairly still. Running ${RUN_SECONDS}s…\n`);
try {
  sdk.useCamera(CameraSelection?.default ?? 0);
  await sdk.start();
} catch (e) {
  console.error("Failed to start:", e?.message || e);
  await shutdown("start-failure");
}
setTimeout(() => shutdown("time limit"), RUN_SECONDS * 1000);
