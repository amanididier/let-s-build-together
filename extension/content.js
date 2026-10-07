// Billy content script. State: OFF → WATCHING → PAUSED (chip) → SELECTING → BOXED (pill: Save / Ask / Copy).
// It never reads the key or calls Gemini; it captures pixels and hands them to the background.
(() => {
  if (window.__billy) return; window.__billy = true;
  let on = false, video = null, player = null, frames = [], timer = null;
  let captions = null, captionsFor = null, captionsSource = "none";
  let snap = null, start = null, payload = null, focus = null, focusTimer = null;

  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:70";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif}
    button{pointer-events:auto;cursor:pointer;border:0;font:600 13px/1 ui-sans-serif,system-ui,sans-serif}
    .chip{position:absolute;padding:9px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.3)}
    #toggle{top:12px;right:12px;background:#1c1917;color:#fafaf9}
    #toggle.on{background:#e85d3a}
    #chip{display:none;top:12px;left:12px;background:#fafaf9;color:#1c1917}
    #layer{display:none;position:absolute;pointer-events:auto;cursor:crosshair;overflow:hidden}
    #layer.empty{background:rgba(0,0,0,.2)}
    #hint{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#1c1917;color:#fafaf9;font-size:13px;padding:6px 12px;border-radius:999px;white-space:nowrap}
    #box{display:none;position:absolute;border:2px solid #e85d3a;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,.35)}
    #pill{display:none;position:absolute;pointer-events:auto;background:#1c1917;color:#fafaf9;border-radius:999px;padding:5px;gap:2px;align-items:center;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:13px;white-space:nowrap}
    #pill button{background:transparent;color:#fafaf9;padding:8px 12px;border-radius:999px}
    #pill button:hover{background:#3a3532}
    #pill button.primary{background:#e85d3a}
    #pill input{pointer-events:auto;background:#fafaf9;color:#1c1917;border:0;border-radius:999px;padding:8px 12px;width:260px;font-size:13px;outline:none}
    .st{padding:0 10px;max-width:360px;white-space:normal;line-height:1.35}
    .err{color:#ffb4a2}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e85d3a;margin-right:6px;animation:p 1s infinite}
    @keyframes p{50%{opacity:.3}}
  </style>
  <button class="chip" id="toggle">Billy · Watch together</button>
  <button class="chip" id="chip">Focus on a moment</button>
  <div id="layer" class="empty"><div id="hint">Drag a box around what you care about · Esc to cancel</div><div id="box"></div></div>
  <div id="pill"></div>`;
  const $ = (id) => root.getElementById(id);
  const toggle = $("toggle"), chip = $("chip"), layer = $("layer"), box = $("box"), pill = $("pill");
  // Keep clicks/keys inside Billy from reaching YouTube (play/pause, shortcuts).
  ["click", "mousedown", "mouseup", "dblclick", "pointerdown", "pointerup"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  ["keydown", "keyup", "keypress"].forEach((ev) => pill.addEventListener(ev, (e) => { if (e.key !== "Escape") e.stopPropagation(); }));

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { state: "error", message: "Billy was updated — reload this page." } : r)); }
    catch { res({ state: "error", message: "Billy was updated — reload this page." }); }
  });

  send({ t: "WATCH_GET" }).then((r) => { on = !!r?.on; render(); init(); });
  toggle.onclick = () => { on = !on; send({ t: "WATCH_SET", on }); render(); init(); };
  function render() { toggle.classList.toggle("on", on); toggle.textContent = on ? "● Billy is watching" : "Billy · Watch together"; if (!on) reset(); }

  const isAd = () => !!document.querySelector(".html5-video-player.ad-showing");
  const vid = () => new URLSearchParams(location.search).get("v");

  function grab(maxW) {
    if (!video || !video.videoWidth) return null;
    const w = Math.min(maxW, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(video, 0, 0, w, h);
    return c;
  }
  function isBlack(c) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0; for (let i = 0; i < d.length; i += 400) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
    return s / n < 8;
  }

  function mount() {
    player = document.querySelector("#movie_player");
    video = player?.querySelector("video.html5-main-video") || player?.querySelector("video");
    if (player && host.parentNode !== player) player.appendChild(host);
    return !!video;
  }

  function reset() { clearInterval(focusTimer); focusTimer = null; focus = null; chip.style.display = "none"; layer.style.display = "none"; pill.style.display = "none"; box.style.display = "none"; snap = null; payload = null; start = null; }

  function init() {
    clearInterval(timer); frames = []; reset();
    if (!vid()) { host.remove(); return; }
    if (!mount()) return setTimeout(init, 800);
    loadCaptions();
    if (!on) return;
    timer = setInterval(() => {
      if (!on || !video || video.paused || isAd()) return;
      const c = grab(640); if (c) { frames.push(c.toDataURL("image/jpeg", 0.6)); if (frames.length > 10) frames.shift(); }
    }, 2000);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    if (video.paused) onPause();
  }
  function onPause() { if (focus) { stopFocus(); return; } if (on && !isAd() && !snap) chip.style.display = "block"; }
  function onPlay() { if (!focus) reset(); }
  document.addEventListener("yt-navigate-finish", () => { if (video) { video.removeEventListener("pause", onPause); video.removeEventListener("play", onPlay); } init(); });

  // ---------- captions: caption track → open transcript panel → none ----------
  async function loadCaptions() {
    const id = vid(); if (!id || captionsFor === id) return; captionsFor = id; captions = null; captionsSource = "none";
    try {
      const html = await (await fetch(`/watch?v=${id}`, { credentials: "include" })).text();
      const m = html.match(/"captionTracks":(\[.*?\])/); if (!m) return;
      const tracks = JSON.parse(m[1]);
      const t = tracks.find((x) => x.languageCode?.startsWith("en")) || tracks[0];
      const txt = await (await fetch(t.baseUrl + "&fmt=json3")).text();
      if (!txt) return;
      const j = JSON.parse(txt);
      captions = (j.events || []).filter((e) => e.segs).map((e) => ({ t: e.tStartMs / 1000, text: e.segs.map((s) => s.utf8).join("").trim() })).filter((c) => c.text);
      if (captions.length) captionsSource = "captions"; else captions = null;
    } catch { captions = null; }
  }
  function panelCaptions() {
    const segs = [...document.querySelectorAll("ytd-transcript-segment-renderer")];
    if (!segs.length) return null;
    return segs.map((s) => {
      const ts = s.querySelector(".segment-timestamp")?.textContent.trim() || "0:00";
      const t = ts.split(":").reduce((a, b) => a * 60 + +b, 0);
      return { t, text: s.querySelector(".segment-text")?.textContent.trim() || "" };
    });
  }
  function windowText(sec) {
    let c = captions;
    if (!c) { c = panelCaptions(); if (c) captionsSource = "transcript panel"; }
    return c ? c.filter((x) => Math.abs(x.t - sec) <= 30).map((x) => `[${Math.floor(x.t)}s] ${x.text}`).join("\n") : "";
  }

  // ---------- geometry ----------
  function pictureRect() { // where the actual picture sits inside the video element (letterbox)
    const r = video.getBoundingClientRect();
    const vA = video.videoWidth / video.videoHeight, rA = r.width / r.height;
    let cw, ch, ox, oy;
    if (rA > vA) { ch = r.height; cw = ch * vA; ox = (r.width - cw) / 2; oy = 0; }
    else { cw = r.width; ch = cw / vA; ox = 0; oy = (r.height - ch) / 2; }
    return { left: r.left + ox, top: r.top + oy, width: cw, height: ch };
  }
  function toFractions(sel) {
    const p = pictureRect(), cl = (n) => Math.min(1, Math.max(0, n));
    const x = cl((sel.left - p.left) / p.width), y = cl((sel.top - p.top) / p.height);
    return { x, y, w: cl((sel.left + sel.width - p.left) / p.width) - x, h: cl((sel.top + sel.height - p.top) / p.height) - y };
  }
  function cropFrom(canvas, b) {
    const sx = b.x * canvas.width, sy = b.y * canvas.height, sw = Math.max(1, b.w * canvas.width), sh = Math.max(1, b.h * canvas.height);
    const c = document.createElement("canvas"); c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // ---------- selection ----------
  chip.onclick = () => {
    if (!mount()) return;
    const full = grab(1280);
    if (!full) return status("Billy can't see this video yet.", true);
    if (isBlack(full)) return status("Billy can't capture this video (protected or black frame).", true);
    snap = { full, current: full.toDataURL("image/jpeg", 0.8), prior: frames.slice(-6), ts: Math.floor(video.currentTime) };
    chip.style.display = "none";
    const pr = player.getBoundingClientRect(), p = pictureRect();
    Object.assign(layer.style, { display: "block", left: p.left - pr.left + "px", top: p.top - pr.top + "px", width: p.width + "px", height: p.height + "px" });
    layer.className = "empty"; box.style.display = "none"; pill.style.display = "none";
  };
  layer.onmousedown = (e) => { e.preventDefault(); start = { x: e.clientX, y: e.clientY }; pill.style.display = "none"; layer.className = ""; box.style.display = "block"; draw(e); };
  layer.onmousemove = (e) => start && draw(e);
  function draw(e) {
    const o = layer.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX, o.left), o.right), y = Math.min(Math.max(e.clientY, o.top), o.bottom);
    Object.assign(box.style, { left: Math.min(start.x, x) - o.left + "px", top: Math.min(start.y, y) - o.top + "px", width: Math.abs(x - start.x) + "px", height: Math.abs(y - start.y) + "px" });
  }
  window.addEventListener("mouseup", () => {
    if (!start) return; start = null;
    const b = box.getBoundingClientRect();
    if (b.width < 8 || b.height < 8) { box.style.display = "none"; layer.className = "empty"; return; }
    const frac = toFractions(b), crop = cropFrom(snap.full, frac);
    payload = {
      requestId: crypto.randomUUID(), videoId: vid(), url: `https://www.youtube.com/watch?v=${vid()}&t=${snap.ts}s`,
      titleGuess: document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, ""),
      channel: document.querySelector("#owner #channel-name a, ytd-channel-name a")?.textContent?.trim() || "",
      timestampSec: snap.ts, box: frac, cropB64: crop.toDataURL("image/jpeg", 0.9), currentFrameB64: snap.current,
      priorFramesB64: snap.prior, transcriptWindow: windowText(snap.ts),
    };
    actions(); // box STAYS; only the pill appears
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (snap || pill.style.display !== "none")) { reset(); if (video?.paused) onPause(); } }, true);

  // ---------- pill ----------
  function placePill() {
    const pr = player.getBoundingClientRect(), b = box.getBoundingClientRect();
    pill.style.display = "flex";
    const pw = pill.offsetWidth, ph = pill.offsetHeight;
    let left = Math.min(Math.max(8, b.left - pr.left), pr.width - pw - 8);
    let top = b.bottom - pr.top + 8; if (top + ph > pr.height - 60) top = Math.max(8, b.top - pr.top - ph - 8);
    if (box.style.display === "none") { left = 12; top = 56; }
    Object.assign(pill.style, { left: left + "px", top: top + "px" });
  }
  function actions() {
    pill.innerHTML = `<button class="primary" data-a="save">Save</button><button data-a="ask">Ask</button><button data-a="copy">Copy</button><button data-a="focus">Focus</button><button data-a="x" title="Cancel (Esc)">✕</button>`;
    placePill();
  }
  function status(text, err, retry) {
    pill.innerHTML = `<span class="st ${err ? "err" : ""}">${text.startsWith("…") ? `<span class="dot"></span>${esc(text.slice(1))}` : esc(text)}</span>${retry ? `<button data-a="retry">Retry</button>` : ""}<button data-a="x">✕</button>`;
    placePill();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let lastMsg = null;
  function fingerprint(canvas) {
    const c = document.createElement("canvas"); c.width = 8; c.height = 8; c.getContext("2d").drawImage(canvas, 0, 0, 8, 8);
    const data = c.getContext("2d").getImageData(0, 0, 8, 8).data; const out = [];
    for (let i = 0; i < data.length; i += 4) out.push(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3));
    return out;
  }
  const differs = (a, b) => !a || a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length > 8;
  function focusStatus() {
    const elapsed = Math.max(0, Math.floor(video.currentTime - focus.startSec));
    pill.innerHTML = `<span class="st"><span class="dot"></span>Focusing ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} · ${focus.samples.length} frames</span><button class="primary" data-a="stop">Stop</button>`;
    placePill();
  }
  function sampleFocus() {
    if (!focus || !video || video.paused || isAd()) return;
    if (video.currentTime - focus.startSec >= 60) { video.pause(); return; }
    const full = grab(960); if (!full || isBlack(full)) return;
    const crop = cropFrom(full, focus.box), print = fingerprint(crop);
    if (focus.samples.length < 24 && differs(focus.lastPrint, print)) {
      focus.samples.push({ tSec: Math.floor(video.currentTime), b64: crop.toDataURL("image/jpeg", 0.72) }); focus.lastPrint = print;
    }
    focusStatus();
  }
  function startFocus() {
    if (!payload) return;
    focus = { startSec: video.currentTime, box: payload.box, samples: [{ tSec: payload.timestampSec, b64: payload.cropB64 }], lastPrint: null, base: payload };
    layer.style.pointerEvents = "none"; box.style.boxShadow = "none"; box.style.background = "rgba(232,93,58,.04)";
    focusStatus(); focusTimer = setInterval(sampleFocus, 500); video.play().catch(() => {});
  }
  function stopFocus() {
    if (!focus) return;
    clearInterval(focusTimer); focusTimer = null; sampleFocus();
    const endSec = Math.max(focus.startSec + 1, video.currentTime);
    payload = { ...focus.base, requestId: crypto.randomUUID(), kind: "clip", startSec: Math.floor(focus.startSec), endSec: Math.floor(endSec), timestampSec: Math.floor(focus.startSec), samples: focus.samples, thumbnailB64: focus.samples[0]?.b64 || focus.base.cropB64, transcriptWindow: windowText((focus.startSec + endSec) / 2) };
    focus = null; layer.style.pointerEvents = "auto";
    pill.innerHTML = `<span class="st">Focused ${formatDuration(payload.endSec - payload.startSec)} · ${payload.samples.length} frames</span><button class="primary" data-a="clip-save">Save</button><button data-a="clip-ask">Ask</button><button data-a="x">✕</button>`; placePill();
  }
  const formatDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, "0")}`;
  async function run(msg, workingText) {
    lastMsg = msg; status("…" + workingText);
    const r = await send(msg);
    if (!r) return status("No answer from Billy. Try again.", true, true);
    status(r.message, r.state === "error", r.state === "error");
  }
  pill.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a; if (!a) return;
    if (a === "x") { reset(); if (video?.paused) onPause(); return; }
    if (a === "retry" && lastMsg) return run(lastMsg, "Trying again…");
    if (a === "stop") { video.pause(); stopFocus(); return; }
    if (!payload) return;
    if (a === "save") return run({ t: "SAVE", p: payload }, "Saving…");
    if (a === "copy") return run({ t: "COPY", p: payload }, "Reading the box…");
    if (a === "focus") { startFocus(); return; }
    if (a === "clip-save") return run({ t: "CLIP_SAVE", p: payload }, "Saving focused clip…");
    if (a === "ask" || a === "clip-ask") {
      pill.innerHTML = `<form><input placeholder="Ask about this…" autofocus><button class="primary">Ask</button><button type="button" data-a="back">←</button></form>`;
      const f = pill.querySelector("form"), i = f.querySelector("input");
      f.style.display = "flex"; f.style.gap = "4px";
      const messageType = a === "clip-ask" ? "CLIP_ASK" : "ASK";
      f.onsubmit = (ev) => { ev.preventDefault(); const q = i.value.trim(); if (q) run({ t: messageType, p: payload, question: q }, "Billy is looking…"); };
      placePill(); setTimeout(() => i.focus(), 0);
    }
    if (a === "back") actions();
  });

  // ---------- messages from the side panel ----------
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.t === "SEEK") {
      if (!video || vid() !== m.videoId) return reply({ ok: false });
      video.currentTime = m.sec; video.pause(); reply({ ok: true });
    }
    if (m.t === "DIAG") {
      const out = { onVideo: !!vid(), video: !!(mount() && video.videoWidth) };
      if (out.video) {
        const c = grab(640); out.frame = !!c; out.black = c ? isBlack(c) : null;
        if (c) { const t = cropFrom(c, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }); out.crop = Math.abs(t.width - c.width / 2) <= 1 && Math.abs(t.height - c.height / 2) <= 1; }
        windowText(video.currentTime);
        out.captions = (captions || panelCaptions() || []).length; out.captionsSource = captionsSource;
      }
      reply(out);
    }
  });
})();
