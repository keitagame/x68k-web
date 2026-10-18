// X68K — WebX68k (https://github.com/uraraworks/WebX68k) の px68k-libretro (wasm) コアを使うフロントエンド。
// コア本体 : core/px68k_libretro.{js,wasm}  (GPL-2.0, px68k-libretro emscripten ブランチのビルド済み)
// ホスト層 : core.js  (WebX68k の src/libretro-host.ts ほかを esbuild で1ファイルにしたもの)
// IPL ROM / CGROM / Human68k 3.02 は system/ に同梱しており、起動時に自動で読み込んで Human68k を起動する。
import { X68Net } from "./net.js";
import { LibretroHost, AudioEngine, codeToRetrok, RETROK, KeyRepeater, isRepeatableKey } from "./core.js";

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const stage = $("stage");
const statusEl = $("status");

/* ------------------------------------------------------------------ */
/* 同梱アセット                                                          */
/* ------------------------------------------------------------------ */
const SYSTEM = {
  ipl: "./system/iplrom.dat",
  cgrom: "./system/cgrom.dat",
  human: "./system/human302.xdf",
};
const HUMAN_NAME = "human302.xdf";
// 機種選択は CPU クロックの切替。同梱IPLは X68000 用 v1.0 のみ。
const MODEL_CPU = { x68000: "10Mhz", xvi: "16Mhz", x68030: "25Mhz" };

/* ------------------------------------------------------------------ */
/* IndexedDB (ROM上書き・SRAM・ステート)                                  */
/* ------------------------------------------------------------------ */
class BinaryStore {
  constructor(dbName, storeName) { this.dbName = dbName; this.storeName = storeName; }
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.storeName)) req.result.createObjectStore(this.storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async put(key, value) {
    const db = await this.open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readwrite");
        tx.objectStore(this.storeName).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async get(key) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(this.storeName).objectStore(this.storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async del(key) {
    const db = await this.open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readwrite");
        tx.objectStore(this.storeName).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
}

/* ------------------------------------------------------------------ */
/* 状態                                                                */
/* ------------------------------------------------------------------ */
const store = new BinaryStore("x68k-px68k", "data");
const slots = { fdd0: null, fdd1: null, fdd2: null, fdd3: null, hdd0: null }; // { name, data }
const fddPaths = { fdd0: "", fdd1: "", fdd2: "", fdd3: "" };
const romNames = { ipl: "", cgrom: "" };

// RS-232C 仮想モデム → net.cgi (TCPゲートウェイ)。?netgw=URL で場所を変えられる。
const net = new X68Net({
  gateway: new URLSearchParams(location.search).get("netgw") || "/cgi-bin/net.cgi",
  onChange: ({ text, error, label }) => {
    if (text) message(text, error);
    const b = document.getElementById("netBtn");
    if (b) b.textContent = label;
  },
});

let host = null;
let audio = null;
let ready = false;
let busy = false;
let paused = false;
let crtOn = false;
let activeModel = "x68000";
let lastFrameTime = 0;
let accumulator = 0;
let frameCount = 0;
let fpsStamp = 0;
let lastSize = "";

/* ------------------------------------------------------------------ */
/* UI ユーティリティ                                                    */
/* ------------------------------------------------------------------ */
function message(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}
function showError(error) {
  console.error(error);
  message(String(error?.message ?? error), true);
}
const DRIVE_IDS = ["fdd0", "fdd1", "fdd2", "fdd3", "hdd0"];

function updateInfo() {
  for (const id of DRIVE_IDS) {
    const label = $(`label-${id}`);
    if (!label) continue;
    const slot = slots[id];
    label.title = slot ? `${id.toUpperCase()}: ${slot.name}` : `${id.toUpperCase()}にディスクを選択`;
    label.style.borderColor = slot ? "#8f8" : "";
  }
  const parts = [];
  if (romNames.ipl) parts.push(`IPL: ${romNames.ipl}`);
  if (romNames.cgrom) parts.push(`CGROM: ${romNames.cgrom}`);
  for (const id of DRIVE_IDS) if (slots[id]) parts.push(`${id.toUpperCase()}: ${slots[id].name}`);
  $("file-name").textContent = parts.join(" / ");
}

function updateStartLabel() {
  $("start").textContent = paused ? "Resume" : "Pause";
}

function setControlsEnabled(enabled) {
  for (const id of ["official", "saveDisk", "saveState", "loadState", "crt", "reset", "start", "model", "netBtn"]) {
    $(id).disabled = !enabled;
  }
}

/** 画面モード(256x256/512x512/768x512 …)の縦横比のまま、表示領域へ収まる最大サイズにする。 */
function fitCanvas() {
  const nativeW = Math.max(1, canvas.width);
  const nativeH = Math.max(1, canvas.height);
  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  if (availW < 2 || availH < 2) return;
  const scale = Math.min((availW - 2) / nativeW, (availH - 2) / nativeH);
  canvas.style.width = `${Math.max(1, Math.floor(nativeW * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(nativeH * scale))}px`;
  canvas.style.aspectRatio = `${nativeW} / ${nativeH}`;
}

/* ------------------------------------------------------------------ */
/* ドライブのアクセスランプ                                              */
/* ------------------------------------------------------------------ */
const ACCESS_HOLD_MS = 150;
const accessUntil = new Map();
function updateAccessLamps(now) {
  const a = host.readDiskAccess();
  if (a.fddReading) accessUntil.set(`fdd${a.fddDrive}`, now + ACCESS_HOLD_MS);
  if (a.hddAccessing) accessUntil.set("hdd0", now + ACCESS_HOLD_MS);
  for (const id of DRIVE_IDS) $(`label-${id}`)?.classList.toggle("reading", (accessUntil.get(id) ?? 0) > now);
}
function clearAccessLamps() {
  accessUntil.clear();
  for (const id of DRIVE_IDS) $(`label-${id}`)?.classList.remove("reading");
}

/* ------------------------------------------------------------------ */
/* ROM / ディスク取得                                                    */
/* ------------------------------------------------------------------ */
async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} の取得に失敗しました (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 保存済み(ユーザーが読み込んだ)ROM があればそれを、無ければ同梱ROMを返す。 */
async function loadRom(kind) {
  const saved = await store.get(`rom:${kind}`).catch(() => undefined);
  if (saved?.bytes) return { name: saved.name, bytes: saved.bytes, bundled: false };
  const bytes = await fetchBytes(SYSTEM[kind]);
  return { name: SYSTEM[kind].split("/").pop(), bytes, bundled: true };
}

let humanCache = null;
async function humanDisk() {
  humanCache ??= await fetchBytes(SYSTEM.human);
  return humanCache.slice();
}

function sanitize(name) { return name.replace(/[\\/]/g, "_"); }
const extension = (name) => name.toLowerCase().split(".").pop() ?? "";
const FLOPPY_EXT = ["xdf", "2hd", "hdm", "dim", "d88", "88d"];
const RAW_2HD_SIZE = 1261568;

/* ------------------------------------------------------------------ */
/* コア起動                                                             */
/* ------------------------------------------------------------------ */
let corePromise = null;
function loadCoreScript() {
  if (window.PX68K) return Promise.resolve();
  corePromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "./core/px68k_libretro.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("コア(core/px68k_libretro.js)の読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  return corePromise;
}

async function ensureAudio() {
  if (!audio) {
    try {
      const engine = new AudioEngine();
      await engine.start();
      audio = engine;
    } catch (error) {
      console.warn("音声を開始できません (HTTPS/localhost が必要です)", error);
      audio = null;
      return;
    }
  }
  audio.resume();
}

function unlockAudioOnce() {
  const handler = () => {
    void ensureAudio().then(() => {
      if (audio?.context?.state === "running") {
        window.removeEventListener("pointerdown", handler, true);
        window.removeEventListener("keydown", handler, true);
      }
    });
  };
  window.addEventListener("pointerdown", handler, true);
  window.addEventListener("keydown", handler, true);
}

/** コアを作り直して起動する。slots の内容を FDD0/FDD1/HDD に載せる。 */
async function bootCore({ keepSlots = true } = {}) {
  ready = false;
  busy = true;
  setControlsEnabled(false);
  try {
    if (host) {
      releaseTransientInputs();
      net.detach();
      host.stopSramAutosave();
      host.dispose();
      host = null;
    }
    audio?.flush();
    clearAccessLamps();
    if (!keepSlots) { slots.fdd0 = slots.fdd1 = slots.fdd2 = slots.fdd3 = slots.hdd0 = null; }
    fddPaths.fdd0 = fddPaths.fdd1 = fddPaths.fdd2 = fddPaths.fdd3 = "";
    activeModel = $("model").value;

    await loadCoreScript();
    const [ipl, cgrom] = await Promise.all([loadRom("ipl"), loadRom("cgrom")]);
    romNames.ipl = ipl.name + (ipl.bundled ? " (同梱)" : "");
    romNames.cgrom = cgrom.name + (cgrom.bundled ? " (同梱)" : "");

    host = new LibretroHost(canvas, (samples) => audio?.push(samples));
    host.onResolutionChanged = fitCanvas;
    // コアオプションは init() の前に渡す
    host.setCoreOption("px68k_cpuspeed", MODEL_CPU[activeModel] ?? "10Mhz");
    host.setCoreOption("px68k_ramsize", "2MB");
    host.setCoreOption("px68k_save_hdd_path", "enabled"); // HDD0 を /system/keropi/config から読む
    host.setCoreOption("px68k_joy_mouse", "Mouse");
    host.setCoreOption("px68k_no_wait_mode", "enabled"); // 進行ペースはこのファイルのループが決める
    host.setCoreOption("px68k_joytype1", "Default (2 Buttons)");
    host.setCoreOption("px68k_joytype2", "Default (2 Buttons)");

    const sram = await store.get(`sram:${activeModel}`).catch(() => undefined);
    await host.init(ipl.bytes, cgrom.bytes, sram ?? undefined);
    host.startSramAutosave((bytes) => {
      store.put(`sram:${activeModel}`, bytes).catch((e) => console.warn("SRAMの保存に失敗", e));
    });
    host.onPoll = pollInputs;

    for (const drive of [0, 1, 2, 3]) {
      const slot = slots[`fdd${drive}`];
      if (slot) fddPaths[`fdd${drive}`] = host.writeDiskImage(`fdd${drive}_${sanitize(floppyFileName(slot.name))}`, slot.data);
    }
    if (slots.hdd0) {
      const hddPath = host.writeDiskImage(`hdd_${sanitize(slots.hdd0.name)}`, slots.hdd0.data);
      host.writeFile("/system/keropi/config", new TextEncoder().encode(`[WinX68k]\r\nHDD0=${hddPath}\r\n`));
    }
    // "px68k <fdd0> <fdd1>" 形式の .cmd で FDD0/FDD1 を同時指定する (空スロットは空文字列)
    host.writeFile("/game/boot.cmd", new TextEncoder().encode(`px68k "${fddPaths.fdd0}" "${fddPaths.fdd1}"\n`));
    if (!host.loadGame("/game/boot.cmd")) throw new Error("コアの起動(retro_load_game)に失敗しました");
    host.fetchAvInfo();
    net.attach(host);
    // FDD2/FDD3 は boot.cmd で指定できないので、起動後にメディア交換として挿入する
    for (const drive of [2, 3]) {
      const path = fddPaths[`fdd${drive}`];
      if (path) host.setFddImage(drive, path);
    }

    lastFrameTime = 0;
    accumulator = 0;
    lastSize = "";
    paused = false;
    ready = true;
    fitCanvas();
    updateInfo();
    updateStartLabel();
  } finally {
    busy = false;
    setControlsEnabled(ready);
    // 起動に失敗しても「Human68k」「CPU選択」から再試行できるようにする
    $("official").disabled = false;
    $("model").disabled = false;
    canvas.focus();
  }
}

/** .hdm / .2hd は生の2HDイメージなので .xdf として渡す(コアは拡張子で形式を判定する)。 */
function floppyFileName(name) {
  const ext = extension(name);
  return ext === "hdm" || ext === "2hd" ? name.replace(/\.[^.]*$/, "") + ".xdf" : name;
}

/** 同梱の Sharp IPL + Human68k 3.02 を FDD0 に入れて(再)起動する。 */
async function bootHuman68k() {
  if (busy) return;
  message("Human68k 3.02 を起動しています…");
  slots.fdd0 = { name: HUMAN_NAME, data: await humanDisk() };
  await bootCore();
  await ensureAudio().catch(() => {});
  message(audioHint("Human68k 3.02 を起動しました"));
}

function audioHint(text) {
  const state = audio?.context?.state;
  return state === "running" ? text : `${text}\n(音声は画面クリックまたはキー入力で有効になります)`;
}

/* ------------------------------------------------------------------ */
/* ファイル読込                                                         */
/* ------------------------------------------------------------------ */
function inferTarget(file) {
  const lower = file.name.toLowerCase();
  const ext = extension(file.name);
  if (ext === "x68state") return "state";
  if (lower.includes("cgrom")) return "cgrom";
  if (lower.includes("ipl") || ext === "rom") return "ipl";
  if (ext === "hdf") return "hdd0";
  if (ext === "dat" && file.size === 131072) return "ipl";
  if (ext === "dat" && file.size === 786432) return "cgrom";
  if (FLOPPY_EXT.includes(ext)) {
    for (const id of ["fdd0", "fdd1", "fdd2", "fdd3"]) if (!slots[id]) return id;
    return "fdd0";
  }
  throw new Error(`${file.name}: 対応していない形式です (xdf/2hd/hdm/dim/d88/88d/hdf/IPL/CGROM/.x68state)`);
}

function mountFloppy(target, name, data) {
  const drive = Number(target.slice(3));
  if (extension(name) === "hdm" && data.byteLength !== RAW_2HD_SIZE) {
    throw new Error(`${name}: 2HD(1,261,568バイト)ではないHDMは未対応です (${data.byteLength}バイト)`);
  }
  // 新イメージを書く → 差し替え → 旧ファイルを消す、の順 (コアへはメディア交換として通知される)
  const oldPath = fddPaths[target];
  const path = host.writeDiskImage(`fdd${drive}_${Date.now()}_${sanitize(floppyFileName(name))}`, data);
  host.setFddImage(drive, path);
  if (oldPath) host.removeFile(oldPath);
  fddPaths[target] = path;
  slots[target] = { name, data };
}

async function loadFile(file, target) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (target === "ipl" || target === "cgrom") {
    await store.put(`rom:${target}`, { name: file.name, bytes });
    message(`${target.toUpperCase()}を保存しました: ${file.name}\n再起動します…`);
    await bootCore();
    message(`${target.toUpperCase()} ${file.name} で再起動しました`);
  } else if (target === "state") {
    if (!host.unserialize(bytes)) throw new Error("ステートの読み込みに失敗しました");
    audio?.flush();
    net.attach(host);
    message(`ステートを読み込みました: ${file.name}`);
  } else if (target === "hdd0") {
    slots.hdd0 = { name: file.name, data: bytes };
    message(`HDDを接続します: ${file.name}\n再起動します…`); // HDD は起動前にしか載せられない
    await bootCore();
    message(`HDDを接続して再起動しました: ${file.name}`);
  } else {
    mountFloppy(target, file.name, bytes);
    message(`${target.toUpperCase()}に接続しました: ${file.name}`);
  }
  updateInfo();
}

async function loadFiles(files) {
  if (!ready || busy) return;
  try {
    for (const file of files) await loadFile(file, inferTarget(file));
  } catch (error) { showError(error); }
  canvas.focus();
}

/* ------------------------------------------------------------------ */
/* 入力: キーボード                                                     */
/* ------------------------------------------------------------------ */
const pressed = new Set();          // 押下中の e.code
let keyRepeater = null;
const repeaterFor = () => {
  keyRepeater ??= new KeyRepeater((retrok) => host?.sendKeyMake(retrok));
  return keyRepeater;
};

// ブラウザの F11/F12 は潰さない
const PASSTHROUGH = new Set(["F11", "F12"]);

// キーボード → ジョイスティック (RetroPad ビット: UP=4 DOWN=5 LEFT=6 RIGHT=7, X68000のA=B(0) / B=A(8))
const JOY_LEFT  = ["ArrowLeft", "Numpad4", "Numpad7", "Numpad1", "KeyA"];
const JOY_RIGHT = ["ArrowRight", "Numpad6", "Numpad9", "Numpad3", "KeyD"];
const JOY_UP    = ["ArrowUp", "Numpad8", "Numpad7", "Numpad9", "KeyW"];
const JOY_DOWN  = ["ArrowDown", "Numpad2", "Numpad1", "Numpad3", "KeyS"];
const JOY_BTN_A = ["KeyZ", "Space", "Enter", "NumpadEnter"];
const JOY_BTN_B = ["KeyX"];
const keyJoy = { enabled: true, port: 0 };
const anyHeld = (list) => list.some((c) => pressed.has(c));

function keyJoyBits() {
  if (!keyJoy.enabled) return 0;
  let bits = 0;
  if (anyHeld(JOY_UP)) bits |= 1 << 4;
  if (anyHeld(JOY_DOWN)) bits |= 1 << 5;
  if (anyHeld(JOY_LEFT)) bits |= 1 << 6;
  if (anyHeld(JOY_RIGHT)) bits |= 1 << 7;
  if (anyHeld(JOY_BTN_A)) bits |= 1 << 0;
  if (anyHeld(JOY_BTN_B)) bits |= 1 << 8;
  return bits;
}

function gamepadBits() {
  const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p);
  if (!pad) return 0;
  const b = (i) => pad.buttons[i]?.pressed ?? false;
  const dz = 0.4;
  let bits = 0;
  if (b(0) || b(2)) bits |= 1 << 0;   // X68000 ボタンA
  if (b(1) || b(3)) bits |= 1 << 8;   // X68000 ボタンB
  if (b(12) || (pad.axes[1] ?? 0) < -dz) bits |= 1 << 4;
  if (b(13) || (pad.axes[1] ?? 0) > dz) bits |= 1 << 5;
  if (b(14) || (pad.axes[0] ?? 0) < -dz) bits |= 1 << 6;
  if (b(15) || (pad.axes[0] ?? 0) > dz) bits |= 1 << 7;
  return bits;
}

/** コアの input_poll から毎フレーム呼ばれる */
function pollInputs() {
  const k = keyJoyBits();
  host.setJoyState(0, gamepadBits() | (keyJoy.port === 0 ? k : 0));
  host.setJoyState(1, keyJoy.port === 1 ? k : 0);
}

function isTextEntry(el) {
  return el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && el.type !== "file");
}

function keyDown(event) {
  if (!ready || event.metaKey || PASSTHROUGH.has(event.code)) return;
  if (document.activeElement !== canvas) {
    if (isTextEntry(document.activeElement)) return;
    canvas.focus();
  }
  if (event.repeat) { event.preventDefault(); return; } // リピートは自前のKeyRepeaterで刻む
  const retrok = codeToRetrok(event.code);
  const joy = keyJoy.enabled && [...JOY_LEFT, ...JOY_RIGHT, ...JOY_UP, ...JOY_DOWN, ...JOY_BTN_A, ...JOY_BTN_B].includes(event.code);
  if (retrok === RETROK.UNKNOWN && !joy) return;
  event.preventDefault();
  const first = !pressed.has(event.code);
  pressed.add(event.code);
  if (retrok !== RETROK.UNKNOWN) {
    host.setKey(retrok, true);
    if (first && isRepeatableKey(retrok)) repeaterFor().start(`physical:${event.code}`, retrok);
  }
}

function keyUp(event) {
  if (!pressed.delete(event.code)) return;
  keyRepeater?.stop(`physical:${event.code}`);
  const retrok = codeToRetrok(event.code);
  if (retrok !== RETROK.UNKNOWN && host) host.setKey(retrok, false);
  event.preventDefault();
}

function releaseTransientInputs() {
  keyRepeater?.stopAll();
  if (host) {
    for (const code of pressed) {
      const retrok = codeToRetrok(code);
      if (retrok !== RETROK.UNKNOWN) host.setKey(retrok, false);
    }
    host.setMouseButton("left", false);
    host.setMouseButton("right", false);
  }
  pressed.clear();
}

/* ------------------------------------------------------------------ */
/* メインループ                                                         */
/* ------------------------------------------------------------------ */
function animate(timestamp) {
  requestAnimationFrame(animate);
  if (!ready || busy || !host) return;
  if (paused) { lastFrameTime = 0; accumulator = 0; return; }
  try {
    if (!lastFrameTime) lastFrameTime = timestamp;
    accumulator = Math.min(accumulator + (timestamp - lastFrameTime) / 1000, 0.1);
    lastFrameTime = timestamp;
    const step = 1 / (host.avInfo?.fps || 60);
    let ran = 0;
    while (accumulator >= step && ran < 3) {
      // 音声が溜まりすぎているときは進めない(遅延が際限なく伸びるのを防ぐ)
      if (audio && audio.queuedSeconds > AudioEngine.MAX_LATENCY_SEC * 0.8) { accumulator = 0; break; }
      host.runFrame();
      accumulator -= step;
      ran++;
    }
    if (!ran) return;
    net.pump(timestamp, ran);
    frameCount += ran;
    const size = `${canvas.width}x${canvas.height}`;
    if (size !== lastSize) { lastSize = size; fitCanvas(); }
    updateAccessLamps(timestamp);
    if (timestamp - fpsStamp >= 1000) {
      $("pc").textContent = `${Math.round((frameCount * 1000) / (timestamp - fpsStamp))} fps`;
      frameCount = 0;
      fpsStamp = timestamp;
    }
  } catch (error) {
    ready = false;
    showError(error);
  }
}

/* ------------------------------------------------------------------ */
/* UI 配線                                                              */
/* ------------------------------------------------------------------ */
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickInput(id, target) {
  $(id).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file && ready && !busy) await loadFile(file, target ?? inferTarget(file)).catch(showError);
    canvas.focus();
  });
}

function wireUi() {
  new ResizeObserver(fitCanvas).observe(stage);
  document.addEventListener("fullscreenchange", () => { fitCanvas(); canvas.focus(); });

  $("model").addEventListener("change", () => {
    void bootCore()
      .then(() => message(`CPU ${MODEL_CPU[activeModel]} で再起動しました`))
      .catch(showError);
  });
  $("official").onclick = () => void bootHuman68k().catch(showError);

  for (const input of document.querySelectorAll(".media-input")) {
    input.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      const target = e.target.dataset.drive;
      e.target.value = "";
      if (file && ready && !busy) await loadFile(file, target).catch(showError);
      canvas.focus();
    });
  }
  pickInput("stateFile", "state");
  pickInput("ipl", "ipl");
  pickInput("cgrom", "cgrom");

  $("start").onclick = () => {
    if (!ready) return;
    paused = !paused;
    if (paused) audio?.flush();
    updateStartLabel();
    canvas.focus();
  };

  $("reset").onclick = () => {
    if (!ready || busy) return;
    audio?.flush();
    host.reset();
    net.attach(host);
    message("リセットしました");
    canvas.focus();
  };

  $("fullscreenBtn").onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen?.().catch(showError);
  };

  $("netBtn").onclick = () => {
    if (!ready) return;
    if (net.online || net.dialing) { net.hangup(); canvas.focus(); return; }
    const to = prompt("接続先 (host:port、例: bbs.example.com:23 / 末尾に ' tls' でTLS)\n※ゲスト側の通信ソフトは ATDT host:port でも発信できます");
    if (to) net.dial(to, { silent: true });
    canvas.focus();
  };

  $("crt").onclick = () => {
    crtOn = !crtOn;
    $("scanlines").classList.toggle("on", crtOn);
    $("crt").textContent = crtOn ? "CRT: ON" : "CRT";
    canvas.focus();
  };

  $("saveDisk").onclick = () => {
    try {
      const slot = slots.fdd0;
      if (!slot || !fddPaths.fdd0) throw new Error("FDD0にディスクがありません");
      download(host.readFile(fddPaths.fdd0), floppyFileName(slot.name));
      message(`FDD0を書き出しました: ${slot.name}`);
    } catch (error) { showError(error); }
  };

  $("saveState").onclick = async () => {
    try {
      const bytes = host.serialize();
      if (!bytes) throw new Error("ステートを作成できませんでした");
      await store.put(`state:${activeModel}`, bytes);
      message("ステートを保存しました (このブラウザ内)\n※ディスクの中身はステートに含まれません");
    } catch (error) { showError(error); }
    canvas.focus();
  };
  $("loadState").onclick = async () => {
    try {
      const bytes = await store.get(`state:${activeModel}`);
      if (!bytes) throw new Error("保存されたステートがありません");
      if (!host.unserialize(bytes)) throw new Error("ステートの読み込みに失敗しました (ディスク構成が違う可能性があります)");
      audio?.flush();
      net.attach(host);
      message("ステートを読み込みました");
    } catch (error) { showError(error); }
    canvas.focus();
  };

  // ドラッグ&ドロップ(画面のどこでも)
  window.addEventListener("dragover", (e) => { e.preventDefault(); canvas.classList.add("drop"); });
  window.addEventListener("dragleave", () => canvas.classList.remove("drop"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    canvas.classList.remove("drop");
    void loadFiles([...(e.dataTransfer?.files ?? [])]);
  });

  // マウス: ダブルクリックでポインタキャプチャ(Escで解除)
  const mouseButton = (b) => (b === 0 ? "left" : b === 2 ? "right" : null);
  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    const b = mouseButton(e.button);
    if (ready && b) host.setMouseButton(b, true);
  });
  window.addEventListener("mouseup", (e) => {
    const b = mouseButton(e.button);
    if (ready && b) host.setMouseButton(b, false);
  });
  canvas.addEventListener("mousemove", (e) => {
    if (ready && document.pointerLockElement === canvas) host.addMouseDelta(e.movementX, e.movementY);
  });
  canvas.addEventListener("dblclick", () => void canvas.requestPointerLock?.());
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === canvas) message("マウスをキャプチャ中 (Escで解除)");
  });
  stage.addEventListener("mousedown", () => canvas.focus());
  $("model").addEventListener("change", () => canvas.focus());

  // キーボード→ジョイスティック切替 (Port1 → Port2 → OFF)
  const keyJoyBtn = $("keyJoy");
  const MODES = ["p1", "p2", "off"];
  const saved = (() => { try { return localStorage.getItem("x68k:keyjoy"); } catch { return null; } })();
  let mode = MODES.includes(saved) ? saved : "p1";
  const applyMode = () => {
    keyJoy.enabled = mode !== "off";
    keyJoy.port = mode === "p2" ? 1 : 0;
    keyJoyBtn.textContent = `Key→Joy: ${mode === "p1" ? "Port1" : mode === "p2" ? "Port2" : "OFF"}`;
  };
  applyMode();
  keyJoyBtn.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    applyMode();
    try { localStorage.setItem("x68k:keyjoy", mode); } catch { /* 保存できなくても動作に影響なし */ }
    canvas.focus();
  });

  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", releaseTransientInputs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") releaseTransientInputs();
  });
}

async function main() {
  setControlsEnabled(false);
  if (!window.isSecureContext) {
    message("HTTPSまたはlocalhostで開いてください(音声と暗号APIが必要です)", true);
  }
  const params = new URLSearchParams(location.search);
  if (params.has("resetrom")) { // ユーザーが読み込んだ ROM を捨てて同梱ROMに戻す
    await store.del("rom:ipl").catch(() => {});
    await store.del("rom:cgrom").catch(() => {});
  }
  const requested = params.get("model");
  if (requested && requested in MODEL_CPU) $("model").value = requested;
  wireUi();
  unlockAudioOnce();
  requestAnimationFrame(animate);
  try {
    // 同梱の IPL ROM / CGROM / Human68k 3.02 で自動起動
    await bootHuman68k();
  } catch (error) {
    setControlsEnabled(!!host);
    showError(error);
  }
}

main().catch(showError);
