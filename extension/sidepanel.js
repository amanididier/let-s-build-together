// Billy side panel: Current | Library | Settings. Reads the last result from session storage, library from IndexedDB (db.js).
const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TYPES = ["inspiration", "visual_step", "code", "command", "website", "tool", "idea", "note", "learning"];
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { state: "error", message: chrome.runtime.lastError.message } : r)));

// ---------- Tabs ----------
function show(tab) {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll("main section").forEach((s) => (s.hidden = s.id !== tab));
  if (tab === "library") renderLibrary();
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));

// ---------- Seek: jump the open tab if it's the same video, else open a new tab ----------
async function seek(videoId, sec, tabId) {
  const tabs = tabId ? [{ id: tabId }] : await chrome.tabs.query({ url: "https://www.youtube.com/*" }).catch(() => []);
  for (const t of tabs) {
    const r = await chrome.tabs.sendMessage(t.id, { t: "SEEK", videoId, sec }).catch(() => null);
    if (r?.ok) { chrome.tabs.update(t.id, { active: true }).catch(() => {}); return; }
  }
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(sec)}s` });
}

const list = (cls, title, arr) => (arr?.length ? `<div class="${cls}"><h4>${title}</h4><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");
const blocks = (bs) => (bs || []).map((b, i) => `<div class="blk"><div class="muted small">${esc(b.kind)}${b.confidence && b.confidence !== "high" ? ` · ${b.confidence} confidence` : ""}</div><pre>${esc(b.content)}</pre>${b.uncertain?.length ? `<div class="muted small">Unsure: ${esc(b.uncertain.join("; "))}</div>` : ""}<button class="ghost copy" data-i="${i}">Copy</button></div>`).join("");
const steps = (st) => (st?.length ? `<h4>Steps</h4><ol>${st.map((s) => `<li>${s.timestampSec != null ? `<span class="ts" data-t="${s.timestampSec}">${fmt(s.timestampSec)}</span> ` : ""}${esc(s.text)}</li>`).join("")}</ol>` : "");
function bind(el, items, videoId, tabId) {
  el.querySelectorAll(".copy").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(items[b.dataset.i].content); b.textContent = "Copied ✓"; }));
  el.querySelectorAll(".ts").forEach((s) => (s.onclick = () => seek(videoId, +s.dataset.t, tabId)));
}

// ---------- Current ----------
async function renderCurrent() {
  const { last } = await chrome.storage.session.get("last");
  const el = $("current");
  if (!last) { el.innerHTML = `<div class="muted">Turn on <b>Watch together</b> on a YouTube video, pause, draw a box, then pick <b>Ask</b> or <b>Copy</b>.</div>`; return; }
  const { p, kind, state, result, question, tabId } = last;
  const head = `<img id="crop" src="${p.cropB64}" alt="Your box"><div class="muted">${esc(p.titleGuess)} · <span class="ts" data-t="${p.timestampSec}">${fmt(p.timestampSec)}</span>${p.transcriptWindow ? "" : " · no transcript"}</div>${question ? `<p><b>You asked:</b> ${esc(question)}</p>` : ""}`;
  let body = "";
  if (state === "working") body = `<div class="card muted">${kind === "ASK" ? "Billy is looking…" : "Reading the box…"}</div>`;
  else if (state === "error") body = `<div class="card err">${esc(last.error)}</div>`;
  else if (kind === "ASK") body = `<div class="card"><p>${esc(result.answer)}</p>${list("obs", "Observed", result.observed)}${list("inf", "Inferred", result.inferred)}${list("cant", "Can't tell", result.cannotTell)}${steps(result.steps)}${result.copyBlocks.length ? "<h4>Copy</h4>" + blocks(result.copyBlocks) : ""}</div>`;
  else body = `<div class="card">${result.artifacts.length ? blocks(result.artifacts) : `<p class="muted">${esc(result.note || "Nothing readable in the box.")}</p>`}</div>`;
  const canSave = state === "done";
  el.innerHTML = head + body + (canSave ? `<div class="row"><button id="remember">Save to library</button><button class="ghost" id="again">Watch again</button></div><div class="muted small">Model: ${esc(last.model)}</div>` : "");
  const items = kind === "ASK" ? result?.copyBlocks : result?.artifacts;
  bind(el, items || [], p.videoId, tabId);
  if (!canSave) return;
  $("again").onclick = () => seek(p.videoId, p.timestampSec, tabId);
  $("remember").onclick = async () => {
    const sd = result.suggestedDiscovery, a0 = result.artifacts?.[0];
    const title = prompt("Title", sd?.title || a0?.content?.slice(0, 60) || p.titleGuess);
    if (title === null) return;
    const btn = $("remember"); btn.disabled = true; btn.textContent = "Saving…";
    const r = await send({ t: "SAVE", p, extra: {
      title, type: sd?.type || (a0 ? KIND_TO_TYPE[a0.kind] : "note"), tags: sd?.tags || [], question: question || "",
      answer: kind === "ASK" ? result : null, artifacts: kind === "COPY" ? result.artifacts : result.copyBlocks,
    } });
    btn.textContent = r?.state === "done" ? "Saved ✓" : (r?.message || "Failed"); if (r?.state !== "done") btn.disabled = false;
  };
}
chrome.storage.session.onChanged.addListener((c) => {
  if (c.last) { renderCurrent(); if (c.last.newValue?.state === "working") show("current"); }
  if (c.libraryChanged && !$("library").hidden) renderLibrary();
});
renderCurrent();

// ---------- Library ----------
TYPES.forEach((t) => $("filter").insertAdjacentHTML("beforeend", `<option>${t}</option>`));
$("search").oninput = renderLibrary; $("filter").onchange = renderLibrary;
const urls = [];
async function renderLibrary() {
  urls.splice(0).forEach(URL.revokeObjectURL);
  const q = $("search").value.toLowerCase().split(/\s+/).filter(Boolean), type = $("filter").value;
  const items = (await DB.all("moments")).sort((a, b) => b.createdAt - a.createdAt).filter((m) => {
    if (type && m.type !== type) return false;
    const hay = [m.title, m.question, m.videoTitle, m.channel, m.answer?.answer, ...(m.tags || []), ...(m.artifacts || []).map((a) => a.content), m.transcript].join(" ").toLowerCase();
    return q.every((w) => hay.includes(w));
  });
  $("list").innerHTML = items.length ? "" : `<p class="muted">${q.length || type ? "No matches." : "Nothing saved yet. Draw a box on a paused video and hit Save."}</p>`;
  for (const m of items) {
    const el = document.createElement("div"); el.className = "card";
    const src = m.crop ? URL.createObjectURL(m.crop) : ""; if (src) urls.push(src);
    el.innerHTML = `${src ? `<img class="thumb" src="${src}">` : ""}<b>${esc(m.title)}</b>
      <div class="muted">${esc(m.videoTitle)} · <span class="ts" data-t="${m.startSec}">${fmt(m.startSec)}</span></div>
      <div><span class="tag">${esc(m.type)}</span>${(m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      ${m.question ? `<p class="muted">Q: ${esc(m.question)}</p>` : ""}${m.answer?.answer ? `<p>${esc(m.answer.answer)}</p>` : ""}${blocks(m.artifacts)}
      <div class="row"><button class="ghost del">Delete</button></div>`;
    bind(el, m.artifacts || [], m.videoId);
    el.querySelector(".del").onclick = async () => { if (confirm("Delete this?")) { await DB.del("moments", m.id); renderLibrary(); } };
    $("list").appendChild(el);
  }
}
const toData = (b) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
$("export").onclick = async () => {
  const moments = await Promise.all((await DB.all("moments")).map(async (m) => ({ ...m, crop: m.crop ? await toData(m.crop) : null })));
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), videos: await DB.all("videos"), moments }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "billy-export.json"; a.click();
};

// ---------- Settings ----------
chrome.storage.local.get(["apiKey", "modelCache"], (r) => {
  if (r.apiKey) $("key").placeholder = "Saved ••••••"; else show("settings");
  if (r.modelCache) $("keyStatus").textContent = `Using ${r.modelCache.name}`;
});
$("save").onclick = async () => {
  const k = $("key").value.trim(); if (!k) return;
  await chrome.storage.local.set({ apiKey: k }); await chrome.storage.local.remove("modelCache");
  $("key").value = ""; $("key").placeholder = "Saved ••••••"; $("test").click();
};
$("test").onclick = async () => {
  $("keyStatus").textContent = "Testing…";
  const r = await send({ t: "TEST_KEY" });
  $("keyStatus").textContent = r?.ok ? `Key works ✓ — using ${r.model} (${r.ms} ms)` : (r?.error || r?.message || "No answer from Billy");
};
