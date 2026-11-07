// Cooldown UI — connects to the local server over SSE, renders derived numbers
// only (never video), and drives the screen flow. The draft text lives only in
// this page's memory; it is never sent to the server.
const TOKEN = window.COOLDOWN_TOKEN;
const $ = (s) => document.querySelector(s);
const screens = [...document.querySelectorAll("[data-screen]")];
let draft = "";
let lastPhase = "consent";

const RING = 339.29; // 2πr for r=54
const fmt = (n, unit) => (n == null ? "—" : `${n}${unit}`);
const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));

function showScreen(name) {
  document.body.dataset.phase = name;
  for (const s of screens) s.hidden = s.dataset.screen !== name;
}

// ---- control ----
async function send(type) {
  try {
    await fetch(`/control?t=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
  } catch {}
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === "arm") {
    draft = $("#draft").value.trim();
    if (!draft) {
      $("#draft").focus();
      return;
    }
  }
  send(a);
});

$("#copyBtn")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(draft);
    $("#copyBtn").textContent = "Copied ✓";
    setTimeout(() => ($("#copyBtn").textContent = "Copy message"), 1600);
  } catch {}
});

// ---- render ----
function render(s) {
  // demo-mode transparency banner
  const db = $("#demoBanner");
  if (s.demo) {
    db.hidden = false;
    db.textContent = `DEMO MODE · ${Math.round(s.demo.minPauseMs / 1000)}s minimum pause · ${Math.round(s.demo.holdMs / 1000)}s stable hold`;
  } else {
    db.hidden = true;
  }

  // phase → screen (client stays on consent until the user begins)
  const map = { idle: "consent", calibrating: "calibrating", ready: "ready", cooldown: "cooldown", released: "released", stopped: "stopped" };
  const screen = map[s.phase] || "consent";
  if (screen !== lastPhase) {
    showScreen(screen);
    lastPhase = screen;
    if (screen === "released") {
      $("#releasedDraft").textContent = draft;
      // honest copy for each way the pause can end
      const r = s.releaseReason;
      if (r === "override") {
        $("#releasedEyebrow").textContent = "released";
        $("#releasedTitle").textContent = "Released.";
        $("#releasedLede").textContent =
          "You chose to release it before your pulse settled — that's your call. Take one more look before you send it.";
      } else if (r === "timeout") {
        $("#releasedEyebrow").textContent = "the pause is over";
        $("#releasedTitle").textContent = "You've had the beat.";
        $("#releasedLede").textContent =
          "You've taken the full pause. Your pulse hasn't fully come down — take one more breath if you need it, then read it once more before you send.";
      } else {
        $("#releasedEyebrow").textContent = "settled";
        $("#releasedTitle").textContent = "You're steady.";
        $("#releasedLede").textContent =
          "Your pulse has come down. Read it once more — then send it, or change it now that you've had the beat.";
      }
    }
  }
  $("#cameraDot").hidden = !(s.phase === "calibrating" || s.phase === "ready" || s.phase === "cooldown");

  const L = s.live || {};

  // calibration
  if (s.phase === "calibrating" && s.calibration) {
    const c = s.calibration;
    const timeP = Math.min(1, c.elapsedMs / c.minMs);
    const sampP = Math.min(1, Math.min(c.pulseSamples, c.breathingSamples) / c.needed);
    const pct = Math.round(100 * Math.min(timeP, sampP));
    $("#calArc").style.strokeDashoffset = RING * (1 - pct / 100);
    $("#calPct").textContent = pct + "%";
    $("#calPulse").textContent = L.pulse ? `${L.pulse.value} bpm` : "—";
    $("#calBreath").textContent = L.breathing ? `${L.breathing.value} /min` : "—";
    $("#calPulseN").textContent = `${c.pulseSamples} clean reading${c.pulseSamples === 1 ? "" : "s"}`;
    $("#calBreathN").textContent = `${c.breathingSamples} clean reading${c.breathingSamples === 1 ? "" : "s"}`;
    $("#calHint").hidden = !s.hint;
    if (s.hint) $("#calHint").textContent = s.hint;
    $("#calProceed").hidden = !c.canProceedAnyway;
  }

  // compose
  if (s.phase === "ready") {
    $("#composePulse").textContent = L.pulse ? `${L.pulse.value} bpm` : "measuring…";
  }

  // cooldown
  if (s.phase === "cooldown") {
    const g = s.gate || {};
    const base = s.baseline || {};
    $("#draftEcho").textContent = draft;

    // breathing meter
    const bm = $("#meterBreath");
    bm.className = "meter" + (g.breathingOk ? " eased" : L.breathing ? " elevated" : "");
    $("#coolBreath").textContent = L.breathing ? `${L.breathing.value} /min` : "—";
    $("#coolBreathState").textContent = !L.breathing
      ? "warming up"
      : g.breathingOk
        ? `eased · near your ${base.breathingBpm?.toFixed?.(0) ?? base.breathingBpm}/min`
        : `above your baseline (${base.breathingBpm?.toFixed?.(0) ?? base.breathingBpm}/min)`;

    // pulse meter (the gate) — eased by returning to baseline OR dropping from the heated peak
    const pm = $("#meterPulse");
    pm.className = "meter" + (g.pulseEased ? " eased" : L.pulse ? " elevated" : "");
    const baseP = base.pulseBpm?.toFixed?.(0) ?? base.pulseBpm;
    $("#coolPulse").textContent = L.pulse ? `${L.pulse.value} bpm` : "—";
    $("#coolPulseState").textContent = !L.pulse
      ? "warming up"
      : g.pulseEased
        ? g.pulseOk
          ? `eased · near your ${baseP} bpm`
          : "easing · coming down"
        : `above your baseline (${baseP} bpm)`;

    // progress: minimum pause first, then the steadiness hold
    const minPauseMet = g.minPauseMet;
    let pct, label;
    const el = g.elapsedMs || 0;
    if (!minPauseMet) {
      pct = Math.min(100, (100 * el) / s.cfg.minPauseMs);
      label = `a minimum pause — ${secs(s.cfg.minPauseMs - el)}s left`;
    } else if (!g.pulseEased) {
      // not settled yet — show the pause running toward its ceiling; it WILL end
      const span = Math.max(1, s.cfg.maxPauseMs - s.cfg.minPauseMs);
      pct = Math.min(100, (100 * (el - s.cfg.minPauseMs)) / span);
      label = `your pulse is still up — the pause ends in ${secs(s.cfg.maxPauseMs - el)}s`;
    } else {
      pct = Math.min(100, (100 * (g.heldMs || 0)) / s.cfg.holdMs);
      label = `holding steady — ${secs(s.cfg.holdMs - (g.heldMs || 0))}s left`;
    }
    $("#pauseFill").style.width = pct + "%";
    $("#pauseLabel").textContent = label;

    // HRV — informational only
    if (L.hrv) {
      $("#coolHrv").innerHTML = `HRV (RMSSD): <strong>${L.hrv.rmssd}</strong> · confidence ${L.hrv.confidence}% <span class="hrvnote">(a 60-second measurement, shown for interest — it does not control the gate)</span>`;
    }

    // the release button reflects state; server auto-advances to "released" on unlock
    const rb = $("#releaseBtn");
    rb.textContent = g.unlocked ? "Settled" : minPauseMet && g.pulseEased ? "Almost…" : "Holding…";
    $("#coolHint").textContent = s.hint || "";
  }
}

// ---- SSE ----
function connect() {
  const es = new EventSource(`/events?t=${TOKEN}`);
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 1500);
  };
}
showScreen("consent");
connect();
