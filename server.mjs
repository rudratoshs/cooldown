// Cooldown — local server. Runs the SmartSpectra SDK on the proven useCamera
// path (validated in Phase 1), owns the baseline + gate state machine, and
// streams ONLY derived numbers to a local browser UI over SSE. The camera frames
// never leave this process: they are not shown, not saved, not transmitted.
//
// Bind: 127.0.0.1 only. A per-boot token gates /events and /control.
// Telemetry: off. Microphone: never opened. Storage: none.

import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_CFG,
  buildBaseline,
  readingTrusted,
  GateTracker,
} from "./signals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4799;
const HOST = "127.0.0.1";
const TOKEN = randomBytes(12).toString("hex");
const STALE_MS = 5000; // a reading older than this is treated as absent
const CAL_MIN_MS = 30000; // minimum calibration time
const CAL_MAX_MS = 75000; // after this, offer proceed-anyway / retry

// ---- key (never logged) --------------------------------------------------
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

// ---- SDK -----------------------------------------------------------------
const SDK = await import("@smartspectra/node-sdk");
const messages = await import("@smartspectra/node-sdk/messages");
const { SmartSpectraSDK, CameraSelection, cardioMetrics = [], breathingMetrics = [], faceMetrics = [] } = SDK;
const decodeMetrics = messages.decodeMetrics;

// ---- runtime state -------------------------------------------------------
// COOLDOWN_DEMO=1 shortens the pause/hold so a full arc fits in a demo video.
// The product default (60s pause + 15s hold) stays meaningful.
const DEMO = process.env.COOLDOWN_DEMO === "1" || process.env.COOLDOWN_DEMO === "true";
const cfg = DEMO ? { ...DEFAULT_CFG, minPauseMs: 20000, holdMs: 8000 } : DEFAULT_CFG;
if (DEMO) console.log("  [demo pacing: 20s minimum pause, 8s hold]");
let sdk = null;
let phase = "idle"; // idle | calibrating | ready | cooldown | released
let calStartedAt = 0;
let baseline = null;
let tracker = null;
const calSamples = { pulse: [], breathing: [] };
const latest = { pulse: null, breathing: null, hrv: null }; // {value/…, confidence, stable, at}
let lastValidationHint = null;

const now = () => Date.now();
const fresh = (r) => (r && now() - r.at <= STALE_MS ? r : null);

function stopSdk() {
  const s = sdk;
  sdk = null;
  if (s) {
    Promise.resolve(s.stopAsync?.()).catch(() => {}).finally(() => s.destroy?.());
  }
}

function startSdk() {
  if (sdk) return;
  sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [...new Set([...cardioMetrics, ...breathingMetrics, ...faceMetrics])],
    enableTelemetry: false,
  });
  sdk.on("metrics", (buf) => {
    let m;
    try {
      m = decodeMetrics(buf);
    } catch {
      return;
    }
    const at = now();
    const lastOf = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
    const p = lastOf(m.cardio?.pulseRate);
    const b = lastOf(m.breathing?.rate);
    const h = lastOf(m.cardio?.hrv);
    if (p) latest.pulse = { value: p.value, confidence: p.confidence, stable: p.stable, at };
    if (b) latest.breathing = { value: b.value, confidence: b.confidence, stable: b.stable, at };
    if (h) latest.hrv = { rmssd: h.rmssd, sdnn: h.sdnn, baevsky: h.baevsky, confidence: h.confidence, at };

    if (phase === "calibrating") {
      if (p && readingTrusted(latest.pulse, cfg.pulseMinConf)) calSamples.pulse.push(latest.pulse);
      if (b && readingTrusted(latest.breathing, cfg.breathingMinConf)) calSamples.breathing.push(latest.breathing);
      const base = buildBaseline(calSamples.pulse, calSamples.breathing, cfg);
      if (base && now() - calStartedAt >= CAL_MIN_MS) {
        baseline = base;
        phase = "ready";
      }
    }
  });
  sdk.on("validationStatus", (code, _ts, hint) => {
    lastValidationHint = hint || (code ? `validation ${code}` : null);
  });
  sdk.on("error", (code, message) => {
    lastValidationHint = `error ${code}: ${message}`;
  });
  try {
    sdk.useCamera(CameraSelection?.default ?? 0);
    sdk.start();
  } catch (e) {
    lastValidationHint = `start failed: ${e?.message || e}`;
    stopSdk();
  }
}

// snapshot of what the UI shows (derived numbers only — never frames)
function snapshot() {
  const fp = fresh(latest.pulse);
  const fb = fresh(latest.breathing);
  const fh = fresh(latest.hrv);
  let gate = null;
  if (phase === "cooldown" && tracker && baseline) {
    gate = tracker.update(now(), { pulse: fp, breathing: fb }, baseline);
    if (gate.unlocked && phase === "cooldown") {
      phase = "released";
      stopSdk(); // message settled — the camera's job is done
    }
  }
  return {
    phase,
    baseline,
    live: {
      pulse: fp ? { value: round1(fp.value), confidence: Math.round(fp.confidence), stable: fp.stable } : null,
      breathing: fb ? { value: round1(fb.value), confidence: Math.round(fb.confidence), stable: fb.stable } : null,
      hrv: fh ? { rmssd: round1(fh.rmssd), sdnn: round1(fh.sdnn), confidence: Math.round(fh.confidence) } : null,
    },
    calibration:
      phase === "calibrating"
        ? {
            elapsedMs: now() - calStartedAt,
            minMs: CAL_MIN_MS,
            maxMs: CAL_MAX_MS,
            pulseSamples: calSamples.pulse.length,
            breathingSamples: calSamples.breathing.length,
            needed: cfg.minBaselineSamples,
            canProceedAnyway: now() - calStartedAt >= CAL_MAX_MS,
          }
        : null,
    gate,
    hint: lastValidationHint,
    cfg: { holdMs: cfg.holdMs, minPauseMs: cfg.minPauseMs },
  };
}
const round1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : x);

// ---- control transitions -------------------------------------------------
function control(type) {
  switch (type) {
    case "calibrate":
      baseline = null;
      calSamples.pulse = [];
      calSamples.breathing = [];
      calStartedAt = now();
      phase = "calibrating";
      startSdk();
      break;
    case "arm": // user pressed Send on a heated message
      if (baseline) {
        tracker = new GateTracker(now(), cfg);
        phase = "cooldown";
      }
      break;
    case "override": // Rule 2: never permanently block a message
      phase = "released";
      stopSdk();
      break;
    case "reset": // write another message
      tracker = null;
      if (baseline) {
        phase = "ready";
        startSdk(); // bring the camera back for the next message
      } else {
        phase = "idle";
      }
      break;
    case "stop":
      phase = "idle";
      stopSdk();
      break;
  }
  return snapshot();
}

// ---- HTTP + SSE ----------------------------------------------------------
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
const clients = new Set();

function authed(req, url) {
  return url.searchParams.get("t") === TOKEN || req.headers["x-cooldown-token"] === TOKEN;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // same-origin only
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    res.writeHead(403).end("forbidden origin");
    return;
  }

  if (url.pathname === "/events") {
    if (!authed(req, url)) return void res.writeHead(403).end("bad token");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/control" && req.method === "POST") {
    if (!authed(req, url)) return void res.writeHead(403).end("bad token");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let type = "";
      try {
        type = JSON.parse(body || "{}").type;
      } catch {}
      const snap = control(String(type));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(snap));
    });
    return;
  }

  // static files
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = join(HERE, "public", file);
  if (!path.startsWith(join(HERE, "public")) || !existsSync(path)) {
    return void res.writeHead(404).end("not found");
  }
  let data = readFileSync(path);
  if (file === "/index.html") data = Buffer.from(String(data).replaceAll("__TOKEN__", TOKEN));
  res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }).end(data);
});

// push state to all SSE clients ~4x/sec
setInterval(() => {
  if (!clients.size) return;
  const line = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(line);
}, 250);

server.listen(PORT, HOST, () => {
  console.log(`\n  Cooldown is running.  Open:  http://${HOST}:${PORT}/?t=${TOKEN}\n`);
  console.log("  (camera starts only after you consent in the page; nothing is stored)\n");
});

process.on("SIGINT", () => {
  stopSdk();
  process.exit(0);
});
