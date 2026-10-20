// Phone player: plays pre-rendered clips from skeleton.pack in a random loop and
// streams the matching jaw angles to the Nano at 50 Hz. See tools/export_phone.py.

import { CH340Link, WebSerialLink, SYNC } from "./link.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JAW_HZ = 50;

// ---------- settings (per phone, kept in localStorage) ----------

const SETTINGS_KEY = "skeleton.settings";
const settings = {
  closed: 125, open: 60, lead_ms: 40, gap_min: 20, gap_max: 45, volume: 1, pools: {},
};

function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
  catch (_) { /* private mode or bad JSON: defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

// ---------- pack storage (IndexedDB, so the pack survives reloads offline) ----------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("skeleton", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const storePack = (blob) => idb("readwrite", (s) => s.put(blob, "pack"));
const loadStoredPack = () => idb("readonly", (s) => s.get("pack"));

async function parsePack(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 8)) !== "SKELPAK1") {
    throw new Error("not a skeleton.pack file");
  }
  const len = new DataView(head.buffer).getUint32(8, true);
  const meta = JSON.parse(await blob.slice(12, 12 + len).text());
  return { blob, meta, base: 12 + len };
}

const part = (p, [off, len]) => p.blob.slice(p.base + off, p.base + off + len);

// ---------- state ----------

let pack = null;
let link = null;
let ctx = null;
let gain = null;
let running = false;
let current = null;      // { clip, jaw, t0 } while a clip plays
let skipGap = null;      // resolves the current gap early
let testAngle = null;    // { angle, until } while calibrating
let wakeLock = null;
let bag = [];
let loopGen = 0;         // bumps on every Start so a stale loop knows to quit
let skipNextGap = false;

function log(msg) {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${msg}\n` + el.textContent.slice(0, 4000);
}

// ---------- Nano ----------

async function connect(kind, device) {
  if (link) await link.close();
  link = null;
  renderStatus();
  const Link = kind === "serial" ? WebSerialLink : CH340Link;
  try {
    const dev = device || (await Link.request());
    const l = new Link();
    $("nanoState").textContent = "Connecting...";
    await l.open(dev);
    l.onclose = () => {
      if (link === l) link = null;
      log("Nano disconnected. Plug it back in; it reconnects by itself.");
      renderStatus();
    };
    const ok = await l.handshake(settings.closed);
    link = l;
    log(ok ? `Nano connected over ${l.label}` : `Connected over ${l.label}, but the Nano didn't answer the handshake. Is jaw_servo.ino uploaded?`);
  } catch (e) {
    if (e.name !== "NotFoundError") log(`Connect failed: ${e.message}`);
    else if (kind === "usb") log("No board picked. If the list was empty, the phone can't see the Nano: use a data USB cable (not charge-only) and an OTG adapter, and turn on OTG in the phone's settings if it has that switch.");
  }
  renderStatus();
}

// Reconnect without a picker when a board this page already knows comes back.
async function autoConnect() {
  if (link) return;
  const usb = await CH340Link.known().catch(() => null);
  if (usb) return connect("usb", usb);
  const port = await WebSerialLink.known().catch(() => null);
  if (port) return connect("serial", port);
}

// ---------- jaw ----------

function heardTime() {
  // Time of the sample coming out of the speaker right now, in context time.
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
}

function levelNow() {
  if (!current || !ctx) return 0;
  const pos = heardTime() - current.t0 + settings.lead_ms / 1000;
  const i = Math.floor((pos * 1000) / pack.meta.frame_ms);
  return i >= 0 && i < current.jaw.length ? current.jaw[i] / 255 : 0;
}

function jawTick() {
  let angle = null;
  if (testAngle && performance.now() < testAngle.until) {
    angle = testAngle.angle;
  } else if (current) {
    angle = Math.round(settings.closed + (settings.open - settings.closed) * levelNow());
  }
  $("jawBar").style.width = current ? `${Math.round(levelNow() * 100)}%` : "0%";
  // Nothing sent while idle: the Nano's failsafe parks the jaw at the rest angle.
  if (angle !== null && link) link.send([SYNC, Math.max(0, Math.min(180, angle))]);
}

// ---------- playback ----------

function enabledClips() {
  return pack.meta.clips.filter((c) => settings.pools[c.pool] !== false);
}

function nextClip() {
  if (!bag.length) {
    bag = enabledClips().slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop() || null;
}

async function prepare(clip) {
  const [audio, jaw] = await Promise.all([
    part(pack, clip.audio).arrayBuffer(),
    part(pack, clip.jaw).arrayBuffer(),
  ]);
  return { clip, buffer: await ctx.decodeAudioData(audio), jaw: new Uint8Array(jaw) };
}

function play(prepared) {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = prepared.buffer;
    src.connect(gain);
    const t0 = ctx.currentTime + 0.1;
    current = { ...prepared, t0, src };
    src.onended = () => { current = null; resolve(); };
    src.start(t0);
    $("nowText").textContent = prepared.clip.text;
    $("nowPool").textContent = prepared.clip.pool;
  });
}

async function gap(alive) {
  const lo = Math.min(settings.gap_min, settings.gap_max);
  const hi = Math.max(settings.gap_min, settings.gap_max);
  const end = performance.now() + (lo + Math.random() * (hi - lo)) * 1000;
  let done = false;
  const skipped = new Promise((r) => { skipGap = () => { done = true; r(); }; });
  if (skipNextGap) { skipNextGap = false; return; }
  while (!done && alive() && performance.now() < end) {
    $("nowPool").textContent = `next in ${Math.ceil((end - performance.now()) / 1000)} s`;
    await Promise.race([sleep(250), skipped]);
  }
  skipGap = null;
}

async function runLoop(gen) {
  const alive = () => running && gen === loopGen;
  let ready = null;
  while (alive()) {
    if (!ready) {
      const clip = nextClip();
      if (!clip) { log("No clips enabled. Tick at least one pool."); break; }
      ready = await prepare(clip);
    }
    if (!alive()) break;
    await play(ready);
    ready = null;
    if (!alive()) break;
    // Decode the next clip during the gap so it starts on time.
    const clip = nextClip();
    const decoding = clip ? prepare(clip).catch((e) => { log(`Bad clip ${clip.id}: ${e.message}`); return null; }) : null;
    $("nowText").textContent = "...";
    await gap(alive);
    ready = decoding ? await decoding : null;
  }
  if (gen === loopGen) stop();
}

async function start() {
  if (!pack) return log("Load a skeleton.pack first.");
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "playback" });
    gain = ctx.createGain();
    gain.connect(ctx.destination);
  }
  gain.gain.value = settings.volume;
  await ctx.resume();
  running = true;
  await keepAwake();
  renderStatus();
  if (!link) log("Playing without the Nano: audio only.");
  skipNextGap = false;
  runLoop(++loopGen).catch((e) => { log(`Playback error: ${e.message}`); stop(); });
}

function stop() {
  running = false;
  if (current) { try { current.src.stop(); } catch (_) { /* already stopped */ } }
  current = null;
  if (skipGap) skipGap();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $("nowText").textContent = "Stopped";
  $("nowPool").textContent = "";
  renderStatus();
}

// Chrome throttles timers on a dark screen, which would freeze the jaw.
async function keepAwake() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) {
    log(`Can't keep the screen on (${e.message}). Turn off auto-lock or the jaw stops when the screen sleeps.`);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running && !wakeLock) keepAwake();
  if (document.visibilityState === "hidden" && running) {
    log("Page went to the background: keep this page on screen or the jaw stalls.");
  }
});

// ---------- loading a pack ----------

async function usePack(blob, fromFile) {
  try {
    const p = await parsePack(blob);
    if (running) stop();
    pack = p;
    bag = [];
    if (fromFile) {
      const d = p.meta.defaults;
      if (!localStorage.getItem(SETTINGS_KEY)) {
        Object.assign(settings, { closed: d.closed_angle, open: d.open_angle, gap_min: d.gap_min_s, gap_max: d.gap_max_s });
        saveSettings();
      }
      await storePack(blob);
      if (navigator.storage?.persist) navigator.storage.persist();
    }
    log(`Pack loaded: ${p.meta.clips.length} clips, ${p.meta.voice}, made ${p.meta.created}`);
  } catch (e) {
    log(`Can't read that pack: ${e.message}`);
  }
  renderPools();
  renderSettings();
  renderStatus();
}

// ---------- UI ----------

function renderStatus() {
  $("nanoState").textContent = link ? `Connected (${link.label})` : "Not connected";
  $("nanoDot").className = "dot " + (link ? "on" : "off");
  $("packState").textContent = pack
    ? `${enabledClips().length} of ${pack.meta.clips.length} clips on`
    : "No pack loaded";
  $("packDot").className = "dot " + (pack ? "on" : "off");
  $("startBtn").textContent = running ? "Stop" : "Start";
  $("startBtn").classList.toggle("stop", running);
  $("nextBtn").disabled = !running;
  $("serialBtn").hidden = !WebSerialLink.supported;
  $("usbBtn").hidden = !CH340Link.supported;
  $("noUsb").hidden = CH340Link.supported || WebSerialLink.supported;
}

function renderPools() {
  const el = $("pools");
  el.innerHTML = "";
  if (!pack) return;
  const counts = {};
  for (const c of pack.meta.clips) counts[c.pool] = (counts[c.pool] || 0) + 1;
  for (const [pool, n] of Object.entries(counts)) {
    const label = document.createElement("label");
    label.className = "pool";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings.pools[pool] !== false;
    box.onchange = () => { settings.pools[pool] = box.checked; bag = []; saveSettings(); renderStatus(); };
    label.append(box, ` ${pool} `, Object.assign(document.createElement("span"), { className: "muted", textContent: `(${n})` }));
    el.append(label);
  }
}

const FIELDS = ["closed", "open", "lead_ms", "gap_min", "gap_max", "volume"];

function renderSettings() {
  for (const f of FIELDS) $(f).value = settings[f];
  $("leadOut").textContent = `${settings.lead_ms} ms`;
  $("volumeOut").textContent = `${Math.round(settings.volume * 100)}%`;
}

function bindSettings() {
  for (const f of FIELDS) {
    $(f).addEventListener("input", () => {
      const v = parseFloat($(f).value);
      if (Number.isNaN(v)) return;
      settings[f] = v;
      saveSettings();
      if (f === "lead_ms") $("leadOut").textContent = `${v} ms`;
      if (f === "volume") { $("volumeOut").textContent = `${Math.round(v * 100)}%`; if (gain) gain.gain.value = v; }
      if (f === "closed" || f === "open") {
        testAngle = { angle: v, until: performance.now() + 1500 };
        if (f === "closed" && link) link.send([0xfd, v]);
      }
    });
  }
  for (const btn of document.querySelectorAll("[data-test]")) {
    btn.onclick = () => {
      testAngle = { angle: settings[btn.dataset.test], until: performance.now() + 1500 };
      if (!link) log("Connect the Nano to test the servo.");
    };
  }
}

function init() {
  loadSettings();
  bindSettings();
  renderSettings();
  renderStatus();

  $("usbBtn").onclick = () => connect("usb");
  $("serialBtn").onclick = () => connect("serial");
  $("packFile").onchange = (e) => { const f = e.target.files[0]; if (f) usePack(f, true); };
  $("startBtn").onclick = () => (running ? stop() : start());
  $("nextBtn").onclick = () => {
    if (skipGap) skipGap();
    else if (current) { skipNextGap = true; try { current.src.stop(); } catch (_) { /* ignore */ } }
  };

  setInterval(jawTick, 1000 / JAW_HZ);

  if ("usb" in navigator) navigator.usb.addEventListener("connect", () => setTimeout(autoConnect, 300));
  if ("serial" in navigator) navigator.serial.addEventListener("connect", () => setTimeout(autoConnect, 300));
  autoConnect();

  loadStoredPack().then((b) => b && usePack(b, false)).catch(() => {});

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
