// Billy content script: chip, pause chip, selection box, frame buffer, captions.
(() => {
  let on = false, video = null, frames = [], timer = null, captions = null, captionsFor = null;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .chip{position:fixed;font:600 13px/1 system-ui,sans-serif;padding:9px 14px;border-radius:999px;border:0;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:.2s}
    #toggle{right:20px;bottom:20px;background:#1c1917;color:#fafaf9}
    #toggle.on{background:#e85d3a}
    #ask{display:none;background:#fafaf9;color:#1c1917}
    #overlay{display:none;position:fixed;cursor:crosshair;background:rgba(0,0,0,.15)}
    #box{position:absolute;border:2px solid #e85d3a;background:rgba(232,93,58,.12);border-radius:4px}
    #hint{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#1c1917;color:#fafaf9;font:13px system-ui;padding:6px 12px;border-radius:999px}
  </style>
  <button class="chip" id="toggle">Billy · Watch together</button>
  <button class="chip" id="ask">Ask Billy</button>
  <div id="overlay"><div id="hint">Drag a box around what you care about · Esc to cancel</div><div id="box"></div></div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => root.getElementById(id);
  const toggle = $("toggle"), askBtn = $("ask"), overlay = $("overlay"), box = $("box");

  chrome.storage.local.get("watchOn", (r) => { on = !!r.watchOn; render(); init(); });
  toggle.onclick = () => { on = !on; chrome.storage.local.set({ watchOn: on }); render(); init(); };
  function render() { toggle.classList.toggle("on", on); toggle.textContent = on ? "Billy is watching ●" : "Billy · Watch together"; if (!on) askBtn.style.display = "none"; }

  const isAd = () => !!document.querySelector(".html5-video-player.ad-showing");
  const vid = () => new URLSearchParams(location.search).get("v");

  function grab(maxW, q = 0.6) {
    if (!video || !video.videoWidth) return null;
    const w = Math.min(maxW, video.videoWidth), h = w * video.videoHeight / video.videoWidth;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(video, 0, 0, w, h);
    return c;
  }
  function isBlack(c) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 400) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 400) < 8;
  }

  function init() {
    clearInterval(timer); frames = []; askBtn.style.display = "none";
    if (!on || !vid()) return;
    video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return setTimeout(init, 800);
    timer = setInterval(() => {
      if (!on || video.paused || isAd()) return;
      const c = grab(640); if (c) { frames.push(c.toDataURL("image/jpeg", 0.6)); if (frames.length > 10) frames.shift(); }
    }, 2000);
    video.onpause = () => { if (!on || isAd()) return; const r = video.getBoundingClientRect(); askBtn.style.left = r.left + 16 + "px"; askBtn.style.top = r.top + 16 + "px"; askBtn.style.display = "block"; };
    video.onplay = () => (askBtn.style.display = "none");
    loadCaptions();
  }
  document.addEventListener("yt-navigate-finish", init);

  async function loadCaptions() {
    const id = vid(); if (captionsFor === id) return; captionsFor = id; captions = null;
    try {
      const html = await (await fetch(`/watch?v=${id}`)).text();
      const m = html.match(/"captionTracks":(\[.*?\])/); if (!m) return;
      const tracks = JSON.parse(m[1]);
      const t = tracks.find((x) => x.languageCode?.startsWith("en")) || tracks[0];
      const j = await (await fetch(t.baseUrl + "&fmt=json3")).json();
      captions = (j.events || []).filter((e) => e.segs).map((e) => ({ t: e.tStartMs / 1000, text: e.segs.map((s) => s.utf8).join("").trim() }));
    } catch { captions = null; }
  }
  const windowText = (sec) => captions ? captions.filter((c) => Math.abs(c.t - sec) <= 30).map((c) => `[${Math.floor(c.t)}s] ${c.text}`).join("\n") : "";

  // Selection
  let start = null;
  askBtn.onclick = () => {
    const r = video.getBoundingClientRect();
    Object.assign(overlay.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    box.style.display = "none";
  };
  overlay.onmousedown = (e) => { start = { x: e.clientX, y: e.clientY }; box.style.display = "block"; draw(e); };
  overlay.onmousemove = (e) => start && draw(e);
  function draw(e) {
    const o = overlay.getBoundingClientRect();
    const l = Math.min(start.x, e.clientX), t = Math.min(start.y, e.clientY);
    Object.assign(box.style, { left: l - o.left + "px", top: t - o.top + "px", width: Math.abs(e.clientX - start.x) + "px", height: Math.abs(e.clientY - start.y) + "px" });
  }
  overlay.onmouseup = (e) => {
    const sel = { left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
    start = null; overlay.style.display = "none";
    if (sel.width < 8 || sel.height < 8) return;
    send(sel);
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { overlay.style.display = "none"; start = null; } });

  function send(sel) {
    const full = grab(1280, 0.85); if (!full) return;
    if (isBlack(full)) return alert("Billy can't see this video (protected or black frame). Try another moment.");
    // Letterbox crop math
    const rect = video.getBoundingClientRect();
    const vA = video.videoWidth / video.videoHeight, rA = rect.width / rect.height;
    let cw, ch, ox, oy;
    if (rA > vA) { ch = rect.height; cw = ch * vA; ox = (rect.width - cw) / 2; oy = 0; }
    else { cw = rect.width; ch = cw / vA; ox = 0; oy = (rect.height - ch) / 2; }
    const scale = full.width / cw;
    const sx = Math.max(0, (sel.left - rect.left - ox) * scale), sy = Math.max(0, (sel.top - rect.top - oy) * scale);
    const sw = Math.min(full.width - sx, sel.width * scale), sh = Math.min(full.height - sy, sel.height * scale);
    const c = document.createElement("canvas"); c.width = sw; c.height = sh;
    c.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    const ts = Math.floor(video.currentTime);
    chrome.runtime.sendMessage({ type: "capture", data: {
      youtubeId: vid(), title: document.title.replace(/ - YouTube$/, ""),
      channel: document.querySelector("#owner #channel-name a, ytd-channel-name a")?.textContent?.trim() || "",
      timestampSec: ts, crop: c.toDataURL("image/jpeg", 0.9), current: full.toDataURL("image/jpeg", 0.8),
      frames: frames.slice(-6), transcript: windowText(ts), captionsAvailable: !!captions
    }});
  }

  chrome.runtime.onMessage.addListener((m) => { if (m.type === "seek" && video) { video.currentTime = m.sec; } });
})();
