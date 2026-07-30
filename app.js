/*
 * Ball Finder — the whole thing running on the phone.
 *
 * No PC, no DroidCam, no WiFi needed once it's installed: the phone's own
 * camera feeds the phone's own copy of the brain, and the phone clicks like a
 * metal detector when it sees a ball.
 *
 * The rules (bar of 40%, four-frames-in-a-row, same-spot) live in
 * ball_detect.js, which is a straight port of the PC's local_infer.py — the
 * two agree to five decimal places (checked with a parity test).
 */

const MODEL_URL = "ball.onnx";
const BEEP_COOLDOWN_MS = 1500;   // don't spam the "found it" buzz
const CLICK_MIN_MS = 60;         // fastest geiger click
const CLICK_MAX_MS = 900;        // slowest geiger click
const HOLD_MS = 800;             // keep clicking this long after the last sighting
const TARGET_MS = 125;           // aim for 8 checks a second -- plenty for walking
                                 // pace, and it saves battery and heat

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");
const statusEl = $("status"), goBtn = $("go"), verdictEl = $("verdict");
const barFill = $("barfill"), tallyEl = $("tally"), meterFill = $("meterfill");
const zoomCv = $("zoom"), zoomCtx = zoomCv.getContext("2d");

let session = null, backend = "";
let running = false, stopping = false;
let audio = null, wakeLock = null, stream = null;
let streak = new BallDetect.Streak();
let geiger = { conf: 0, pan: 0, until: 0 };
let stats = { frames: 0, finds: 0, startedAt: 0, fps: 0, best: 0 };
let lastBuzz = 0;

// the 640x640 scratch pad we squash each camera frame onto
const work = document.createElement("canvas");
work.width = work.height = BallDetect.MODEL_SIZE;
const workCtx = work.getContext("2d", { willReadFrequently: true });
const input = new Float32Array(3 * BallDetect.MODEL_SIZE * BallDetect.MODEL_SIZE);

function say(html) { statusEl.innerHTML = html; }

/* ---------------- loading the brain ---------------- */

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // must be a real relative URL ("./"), not a bare name — the runtime loads
  // its helper file as a module and bare names are rejected
  ort.env.wasm.wasmPaths = new URL("ort/", location.href).href;
  // Extra threads only work on a page the host serves with the isolation
  // headers (see _headers). Without them, one thread — still fine.
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

  let bytes;
  try {
    bytes = await fetchWithProgress(MODEL_URL);
  } catch (e) {
    say(`Could not load the brain file.<br><b>${e.message}</b>`);
    return;
  }
  barFill.style.width = "100%";

  for (const ep of ["webgpu", "wasm"]) {
    try {
      say(`Starting the brain (${ep === "webgpu" ? "graphics chip" : "processor"})&hellip;`);
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
      // one warm-up run so the first real frame isn't slow
      await session.run({ images: new ort.Tensor("float32", input, [1, 3, 640, 640]) });
      backend = ep === "webgpu" ? "graphics chip" : "processor";
      break;
    } catch (e) {
      console.warn(ep + " failed:", e);
      session = null;
    }
  }
  barFill.style.width = "0";
  if (!session) { say("The brain would not start on this phone."); return; }

  say(`Brain ready (using the <b>${backend}</b>). Tap START, then walk.`);
  goBtn.disabled = false;
}

async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const total = +res.headers.get("content-length") || 10604139;
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    barFill.style.width = Math.min(100, (got / total) * 100) + "%";
    say(`Loading the brain&hellip; <b>${Math.round((got / total) * 100)}%</b>`);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/* ---------------- sound: the geiger clicker ---------------- */

function click(heat, pan) {
  if (!audio || !$("sound").checked) return;
  const o = audio.createOscillator(), g = audio.createGain(), p = audio.createStereoPanner();
  o.frequency.value = 700 + 900 * heat;
  g.gain.setValueAtTime(0.5, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.08);
  p.pan.value = pan;
  o.connect(g); g.connect(p); p.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + 0.09);
}

function beep(freq, ms) {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.35, audio.currentTime);
  g.gain.setValueAtTime(0.35, audio.currentTime + ms / 1000 - 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
  o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + ms / 1000);
}

const heatOf = (conf) => Math.min(1, Math.max(0, (conf - 0.40) / 0.50));

// Its own little loop so clicks can run faster than the camera frames.
function ticker() {
  if (!running) return;
  const hot = Date.now() < geiger.until;
  const heat = heatOf(geiger.conf);
  if (hot) click(heat, geiger.pan);
  setTimeout(ticker, hot ? Math.max(CLICK_MIN_MS, CLICK_MAX_MS - 840 * heat) : 150);
}

/* ---------------- start / stop ---------------- */

goBtn.onclick = () => (running ? stop() : start());

async function start() {
  goBtn.disabled = true;
  // Sound has to be switched on inside the tap, or Android blocks it.
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
  } catch (e) {
    audio = null;   // no sound available; boxes and buzzing still work
  }

  try {
    say("Turning the camera on&hellip;");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    say(`No camera: <b>${e.name}</b>. Allow camera access for this app, then tap START again.`);
    goBtn.disabled = false;
    return;
  }
  video.srcObject = stream;
  await video.play();
  // some phones hand over an upright picture, some a wide one -- fit the
  // preview to whatever this camera actually gives
  if (video.videoWidth) {
    $("stage").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
  await keepScreenAwake();

  running = true; stopping = false;
  streak = new BallDetect.Streak();
  stats = { frames: 0, finds: 0, startedAt: Date.now(), fps: 0, best: 0 };
  goBtn.textContent = "STOP";
  goBtn.classList.add("stop");
  goBtn.disabled = false;

  await headStart(+$("headstart").value);
  if (!running) return;          // they hit STOP during the countdown
  stats.startedAt = Date.now();
  ticker();
  pump();
}

// One beep a second while you walk out, then three high ones = now scanning.
async function headStart(seconds) {
  for (let s = seconds; s > 0 && running; s--) {
    say(`Walk out&hellip; starting in <b>${s}</b>`);
    beep(700, 90);
    await sleep(1000);
  }
  if (!running) return;
  for (let i = 0; i < 3 && running; i++) { beep(1500, 120); await sleep(180); }
}

function stop() {
  running = false;
  goBtn.textContent = "START";
  goBtn.classList.remove("stop");
  verdictEl.classList.remove("on");
  verdictEl.textContent = "READY";
  meterFill.style.width = "0";
  meterFill.classList.remove("on");
  zoomCv.classList.remove("on");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  beep(400, 250);
  const mins = (Date.now() - stats.startedAt) / 60000;
  say(`Run finished: <b>${stats.finds}</b> ball alert(s) in <b>${mins.toFixed(1)}</b> min ` +
      `(${stats.frames} pictures checked). Tap START to go again.`);
  tallyEl.textContent = "";
}

async function keepScreenAwake() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not fatal — the screen may just dim */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running && !wakeLock) keepScreenAwake();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) =>
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => r())
                                  : requestAnimationFrame(() => r()));

/* ---------------- the scanning loop ---------------- */

async function pump() {
  let fpsMark = performance.now(), fpsCount = 0;

  while (running) {
    await nextFrame();
    if (!running) break;
    if (!video.videoWidth) continue;

    const began = performance.now();
    const preds = await detectOnce();
    if (!running) break;
    stats.frames++;

    const s = streak.update(preds);
    stats.best = preds.length ? preds[0].confidence : 0;

    if (s.hot) {
      const p = s.best;
      geiger = {
        conf: p.confidence,
        pan: (p.x / video.videoWidth) * 2 - 1,   // -1 left .. +1 right
        until: Date.now() + HOLD_MS,
      };
      const now = Date.now();
      if (now - lastBuzz > BEEP_COOLDOWN_MS) {
        lastBuzz = now;
        stats.finds++;
        if ($("buzz").checked && navigator.vibrate) navigator.vibrate([90, 60, 90]);
      }
    }

    draw(preds, s);

    if (++fpsCount >= 5) {
      stats.fps = (fpsCount * 1000) / (performance.now() - fpsMark);
      fpsMark = performance.now(); fpsCount = 0;
    }
    showScanning(s);

    const spare = TARGET_MS - (performance.now() - began);
    if (spare > 5) await sleep(spare);   // breathe, so the phone stays cool
  }
}

async function detectOnce() {
  workCtx.drawImage(video, 0, 0, work.width, work.height);   // squash to 640x640
  const px = workCtx.getImageData(0, 0, work.width, work.height).data;
  const area = work.width * work.height;
  for (let i = 0, j = 0; i < area; i++, j += 4) {            // to RGB, 0..1, plane by plane
    input[i] = px[j] / 255;
    input[area + i] = px[j + 1] / 255;
    input[2 * area + i] = px[j + 2] / 255;
  }
  const out = await session.run({ images: new ort.Tensor("float32", input, [1, 3, 640, 640]) });
  const data = out[session.outputNames[0]].data;
  return BallDetect.decode(data, video.videoWidth, video.videoHeight);
}

/* ---------------- what you see ---------------- */

function draw(preds, s) {
  const r = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== Math.round(r.width * dpr)) {
    overlay.width = Math.round(r.width * dpr);
    overlay.height = Math.round(r.height * dpr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // the meter and the words say what the brain thinks, every frame
  const conf = preds.length ? preds[0].confidence : 0;
  meterFill.style.width = Math.round(conf * 100) + "%";
  meterFill.classList.toggle("on", !!s.hot);

  if (!preds.length) {
    verdictEl.classList.remove("on");
    verdictEl.textContent = "SCANNING";
    zoomCv.classList.remove("on");
    return;
  }

  // the video sits letterboxed inside its box, so work out where the picture is
  const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight) * dpr;
  const offX = (overlay.width - video.videoWidth * scale) / 2;
  const offY = (overlay.height - video.videoHeight * scale) / 2;

  const p = preds[0];
  const x = offX + (p.x - p.width / 2) * scale, y = offY + (p.y - p.height / 2) * scale;
  const w = p.width * scale, h = p.height * scale;
  // black outline under magenta: the only combination that shows up on grass
  ctx.lineWidth = 8 * dpr; ctx.strokeStyle = "#000";
  ctx.strokeRect(x, y, w, h);
  ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = s.hot ? "#ff2fff" : "#ffa53d";
  ctx.strokeRect(x, y, w, h);
  ctx.font = `${Math.round(15 * dpr)}px system-ui`;
  ctx.lineWidth = 5 * dpr; ctx.strokeStyle = "#000";
  const label = Math.round(p.confidence * 100) + "%";
  ctx.strokeText(label, x, Math.max(16 * dpr, y - 7 * dpr));
  ctx.fillStyle = s.hot ? "#ff2fff" : "#ffa53d";
  ctx.fillText(label, x, Math.max(16 * dpr, y - 7 * dpr));

  drawZoom(p, s.hot);

  const pct = Math.round(p.confidence * 100);
  if (s.hot) {
    const side = geiger.pan < -0.2 ? "&lsaquo;&lsaquo; LEFT"
               : geiger.pan > 0.2 ? "RIGHT &rsaquo;&rsaquo;" : "AHEAD";
    verdictEl.innerHTML = `BALL ${side} ${pct}%`;
    verdictEl.classList.add("on");
  } else {
    verdictEl.textContent = `maybe… ${pct}% (${s.streak}/${BallDetect.CONSECUTIVE_FRAMES_NEEDED})`;
    verdictEl.classList.remove("on");
  }
}

// A close-up of whatever it is looking at, so you can judge it yourself
// without squinting at a thumbnail — same idea as review_detections.py.
function drawZoom(p, hot) {
  const side = Math.max(p.width, p.height) * 4;   // show 4 ball-widths of context
  const sx = Math.max(0, Math.min(video.videoWidth - side, p.x - side / 2));
  const sy = Math.max(0, Math.min(video.videoHeight - side, p.y - side / 2));
  zoomCtx.imageSmoothingEnabled = false;
  zoomCtx.drawImage(video, sx, sy, side, side, 0, 0, zoomCv.width, zoomCv.height);
  const bx = ((p.x - p.width / 2) - sx) / side * zoomCv.width;
  const by = ((p.y - p.height / 2) - sy) / side * zoomCv.height;
  const bw = p.width / side * zoomCv.width, bh = p.height / side * zoomCv.height;
  zoomCtx.lineWidth = 5; zoomCtx.strokeStyle = "#000"; zoomCtx.strokeRect(bx, by, bw, bh);
  zoomCtx.lineWidth = 2; zoomCtx.strokeStyle = hot ? "#ff2fff" : "#ffa53d";
  zoomCtx.strokeRect(bx, by, bw, bh);
  zoomCv.classList.toggle("on", !!hot);
}

function showScanning(s) {
  const bestTxt = stats.best ? `best <b>${Math.round(stats.best * 100)}%</b>` : "nothing yet";
  say(s.hot ? `<b>Look down &mdash; ball!</b> The close-up shows what it sees.`
            : `Scanning&hellip; ${bestTxt}`);
  tallyEl.textContent = `${stats.fps.toFixed(1)} checks/s · ${stats.finds} alert(s) · ${backend}`;
}

init();
