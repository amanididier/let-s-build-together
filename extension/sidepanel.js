// Billy side panel: Current | Library | Settings. Data lives in IndexedDB.
const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TYPES = ["inspiration","visual_step","code","command","website","tool","idea","note","learning"];

// ---------- DB ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("billy", 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("videos", { keyPath: "id" }); d.createObjectStore("discoveries", { keyPath: "id" }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) { const d = await dbp; return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); }
const all = (s) => tx(s, "readonly", (st) => st.getAll());
const put = (s, v) => tx(s, "readwrite", (st) => st.put(v));
const del = (s, k) => tx(s, "readwrite", (st) => st.delete(k));

// ---------- Tabs ----------
document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("main section").forEach((s) => s.hidden = s.id !== b.dataset.tab);
  if (b.dataset.tab === "library") renderLibrary();
});

// ---------- Current ----------
let pending = null, last = null;
async function loadPending() {
  const { pending: p } = await chrome.storage.session.get("pending");
  if (!p) return; pending = p; last = null;
  $("empty").hidden = true; $("ask").hidden = false;
  $("crop").src = p.crop; $("meta").textContent = `${p.title} · ${fmt(p.timestampSec)}${p.captionsAvailable ? "" : " · no transcript"}`;
  $("answer").innerHTML = ""; $("q").value = ""; $("q").focus();
}
chrome.storage.session.onChanged.addListener((c) => c.pending && loadPending());
loadPending();

function call(msg) {
  return new Promise((res) => { const port = chrome.runtime.connect(); port.onMessage.addListener((m) => { res(m); port.disconnect(); }); port.postMessage(msg); });
}

$("form").onsubmit = async (e) => {
  e.preventDefault(); const question = $("q").value.trim(); if (!question || !pending) return;
  const btn = e.target.querySelector("button"); btn.disabled = true;
  $("answer").innerHTML = `<div class="card muted">Billy is looking…</div>`;
  const r = await call({ type: "ask", data: { ...pending, question } });
  btn.disabled = false;
  if (!r.ok) { $("answer").innerHTML = `<div class="card">${esc(r.error)}</div>`; return; }
  last = { question, ...r.result }; renderAnswer(last);
};

const list = (cls, title, arr) => arr?.length ? `<div class="${cls}"><h4>${title}</h4><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";
function blocksHtml(bs) { return bs.map((b, i) => `<pre>${esc(b.content)}</pre><button class="ghost copy" data-i="${i}">Copy</button>`).join(""); }
function stepsHtml(st) { return st?.length ? `<h4>Steps</h4><ol>${st.map((s) => `<li>${s.timestampSec != null ? `<span class="ts" data-t="${s.timestampSec}">${fmt(s.timestampSec)}</span> ` : ""}${esc(s.text)}</li>`).join("")}</ol>` : ""; }

function renderAnswer(a) {
  $("answer").innerHTML = `<div class="card"><p>${esc(a.answer)}</p>
    ${list("obs", "Observed", a.observed)}${list("inf", "Inferred", a.inferred)}${list("cant", "Can't tell", a.cannotTell)}
    ${stepsHtml(a.steps)}${a.copyBlocks.length ? "<h4>Copy</h4>" + blocksHtml(a.copyBlocks) : ""}
    <div class="row"><button id="remember">Remember</button><button class="ghost" id="copyAll">Copy answer</button><button class="ghost" id="watch">Watch again</button></div></div>`;
  bindCommon($("answer"), a.copyBlocks, pending.youtubeId, pending.tabId);
  $("copyAll").onclick = () => navigator.clipboard.writeText(a.answer);
  $("watch").onclick = () => seek(pending.tabId, pending.youtubeId, pending.timestampSec);
  $("remember").onclick = () => remember();
}

function bindCommon(el, blocks, ytId, tabId) {
  el.querySelectorAll(".copy").forEach((b) => b.onclick = () => { navigator.clipboard.writeText(blocks[b.dataset.i].content); b.textContent = "Copied"; });
  el.querySelectorAll(".ts").forEach((s) => s.onclick = () => seek(tabId, ytId, +s.dataset.t));
}
function seek(tabId, ytId, sec) {
  chrome.tabs?.update ? null : null;
  window.open(`https://www.youtube.com/watch?v=${ytId}&t=${Math.floor(sec)}s`, "_blank");
}

async function remember() {
  const p = pending, a = last, sd = a.suggestedDiscovery;
  const title = prompt("Title for this discovery", sd.title); if (title === null) return;
  const crop = await (await fetch(p.crop)).blob();
  await put("videos", { id: p.youtubeId, youtubeId: p.youtubeId, title: p.title, channel: p.channel, url: `https://www.youtube.com/watch?v=${p.youtubeId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${p.youtubeId}/mqdefault.jpg`, captionsAvailable: p.captionsAvailable, lastWatchedAt: Date.now() });
  await put("discoveries", { id: crypto.randomUUID(), videoId: p.youtubeId, videoTitle: p.title, timestampSec: p.timestampSec,
    title, type: sd.type, tags: sd.tags, question: a.question, answer: a.answer, observed: a.observed, inferred: a.inferred,
    cannotTell: a.cannotTell, steps: a.steps, copyBlocks: a.copyBlocks, transcriptContext: p.transcript, cropImage: crop, projectIds: [], createdAt: Date.now() });
  $("remember").textContent = "Remembered ✓"; $("remember").disabled = true;
}

// ---------- Library ----------
TYPES.forEach((t) => $("filter").insertAdjacentHTML("beforeend", `<option>${t}</option>`));
$("search").oninput = renderLibrary; $("filter").onchange = renderLibrary;
const urls = [];
async function renderLibrary() {
  urls.splice(0).forEach(URL.revokeObjectURL);
  const q = $("search").value.toLowerCase().split(/\s+/).filter(Boolean), type = $("filter").value;
  const items = (await all("discoveries")).sort((a, b) => b.createdAt - a.createdAt).filter((d) => {
    if (type && d.type !== type) return false;
    const hay = [d.title, d.answer, d.question, d.videoTitle, ...d.tags, ...d.observed, d.transcriptContext].join(" ").toLowerCase();
    return q.every((w) => hay.includes(w));
  });
  $("list").innerHTML = items.length ? "" : `<p class="muted">Nothing saved yet. Tap <b>Remember</b> on an answer.</p>`;
  for (const d of items) {
    const el = document.createElement("div"); el.className = "card";
    const src = d.cropImage ? URL.createObjectURL(d.cropImage) : ""; if (src) urls.push(src);
    el.innerHTML = `${src ? `<img class="thumb" src="${src}">` : ""}<b>${esc(d.title)}</b>
      <div class="muted">${esc(d.videoTitle)} · <span class="ts" data-t="${d.timestampSec}">${fmt(d.timestampSec)}</span></div>
      <div><span class="tag">${d.type}</span>${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      <p>${esc(d.answer)}</p>${blocksHtml(d.copyBlocks)}
      <div class="row"><button class="ghost del">Delete</button></div>`;
    bindCommon(el, d.copyBlocks, d.videoId);
    el.querySelector(".del").onclick = async () => { if (confirm("Delete this discovery?")) { await del("discoveries", d.id); renderLibrary(); } };
    $("list").appendChild(el);
  }
}
$("export").onclick = async () => {
  const ds = await Promise.all((await all("discoveries")).map(async (d) => ({ ...d, cropImage: d.cropImage ? await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(d.cropImage); }) : null })));
  const blob = new Blob([JSON.stringify({ videos: await all("videos"), discoveries: ds }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "billy-export.json"; a.click();
};

// ---------- Settings ----------
chrome.storage.local.get("apiKey", (r) => { if (r.apiKey) $("key").placeholder = "Saved ••••••"; else document.querySelector('[data-tab="settings"]').click(); });
$("save").onclick = async () => { const k = $("key").value.trim(); if (!k) return; await chrome.storage.local.set({ apiKey: k }); $("key").value = ""; $("key").placeholder = "Saved ••••••"; $("keyStatus").textContent = "Saved."; };
$("test").onclick = async () => { $("keyStatus").textContent = "Testing…"; const r = await call({ type: "testKey" }); $("keyStatus").textContent = r.ok ? "Key works ✓" : r.error; };
