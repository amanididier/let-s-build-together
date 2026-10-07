// Billy side panel. One workspace: Now, Library and Settings.
const byId = (id) => document.getElementById(id);
const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatTime = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? { state: "error", message: chrome.runtime.lastError.message } : response)));
const objectUrls = [];
let activeKind = "all";
let openMoment = null;
let diagnosticsText = "";

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== name; });
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "library") renderLibrary();
}
document.querySelectorAll("[data-view]").forEach((button) => { button.onclick = () => showView(button.dataset.view); });

async function seek(videoId, seconds, tabId) {
  const candidates = tabId ? [{ id: tabId }] : await chrome.tabs.query({ url: "https://www.youtube.com/*" }).catch(() => []);
  for (const tab of candidates) {
    const result = await chrome.tabs.sendMessage(tab.id, { t: "SEEK", videoId, sec: seconds }).catch(() => null);
    if (result?.ok) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      return;
    }
  }
  await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(seconds)}s` });
}

function artifactsHtml(items = []) {
  return items.map((item, index) => `<div class="artifact">
    <div class="artifact-head"><span class="artifact-kind">${safe(item.kind)}${item.confidence && item.confidence !== "high" ? ` · ${safe(item.confidence)}` : ""}</span><div class="artifact-actions">${item.kind === "url" ? `<button class="mini open-artifact" data-index="${index}">Open</button>` : ""}<button class="mini copy-artifact" data-index="${index}">Copy</button></div></div>
    <pre>${safe(item.content)}</pre>${item.uncertain?.length ? `<div class="uncertain">Check: ${safe(item.uncertain.join("; "))}</div>` : ""}
  </div>`).join("");
}

function bindArtifacts(container, items = []) {
  container.querySelectorAll(".copy-artifact").forEach((button) => { button.onclick = async () => { const item = items[Number(button.dataset.index)]; if (!item) return; await navigator.clipboard.writeText(item.content); button.textContent = "Copied"; }; });
  container.querySelectorAll(".open-artifact").forEach((button) => { button.onclick = () => { const item = items[Number(button.dataset.index)]; if (item?.content) chrome.tabs.create({ url: /^https?:\/\//i.test(item.content) ? item.content : `https://${item.content}` }); }; });
}

function factGroup(label, className, values = []) {
  return values.length ? `<div class="fact-group ${className}"><h3>${label}</h3><ul>${values.map((value) => `<li>${safe(value)}</li>`).join("")}</ul></div>` : "";
}

async function renderCurrent() {
  const current = byId("current");
  const { last } = await chrome.storage.session.get("last");
  if (!last) {
    current.innerHTML = `<div class="welcome"><div class="welcome-mark"><img src="icons/icon48.png" alt=""></div><p class="eyebrow">Ready when you are</p><h1>Understand any moment.</h1><p>On YouTube, turn Billy on, pause, and draw around what matters.</p><div class="flow"><div><b>01</b>Pause</div><div><b>02</b>Point</div><div><b>03</b>Ask, save or copy</div></div></div>`;
    return;
  }
  const { p = {}, kind, state, result = {}, question, tabId, error, model } = last;
  const source = `${safe(p.titleGuess || "YouTube moment")} · ${formatTime(p.timestampSec || p.startSec)}`;
  const image = p.cropB64 || p.thumbnailB64;
  let body = "";
  if (state === "working") body = `<div class="status-card">${kind === "COPY" ? "Reading exactly what is inside your box…" : "Billy is looking at this moment…"}</div>`;
  if (state === "error") body = `<div class="status-card error"><b>Billy could not finish</b><br>${safe(error || "Try again from the video.")}</div>`;
  if (state === "done" && (kind === "ASK" || kind === "CLIP_ASK")) {
    body = `<div class="answer">${question ? `<p class="question">You asked: ${safe(question)}</p>` : ""}<p class="lead">${safe(result.answer)}</p>${factGroup("Observed", "observed", result.observed)}${factGroup("Inferred", "inferred", result.inferred)}${factGroup("Can't tell", "cannot", result.cannotTell)}${result.steps?.length ? `<div class="fact-group"><h3>Steps</h3><ol class="steps">${result.steps.map((step) => `<li>${safe(step.text)}</li>`).join("")}</ol></div>` : ""}${artifactsHtml(result.copyBlocks)}</div>`;
  }
  if (state === "done" && kind === "COPY") body = `<div class="answer">${result.artifacts?.length ? artifactsHtml(result.artifacts) : `<div class="status-card">${safe(result.note || "Nothing readable was found inside the box.")}</div>`}</div>`;
  current.innerHTML = `${image ? `<div class="capture"><img src="${image}" alt="Selected video area"><div class="source">${source}</div></div>` : ""}${body}${state === "done" ? `<div class="action-row"><button id="remember" class="primary">Save to library</button><button id="watchAgain" class="secondary">Watch again</button></div><div class="status-line">${model ? `Answered with ${safe(model)}` : "Saved locally"}</div>` : ""}`;
  const items = kind === "COPY" ? result.artifacts : result.copyBlocks;
  bindArtifacts(current, items || []);
  if (state !== "done") return;
  byId("watchAgain").onclick = () => seek(p.videoId, p.timestampSec ?? p.startSec, tabId);
  byId("remember").onclick = async () => {
    const button = byId("remember"); button.disabled = true; button.textContent = "Saving…";
    const suggested = result.suggestedDiscovery || {};
    const response = await send({ t: kind === "CLIP_ASK" ? "CLIP_SAVE" : "SAVE", p, extra: { title: suggested.title || result.artifacts?.[0]?.content?.slice(0, 70) || p.titleGuess, type: suggested.type || "note", tags: suggested.tags || [], question: question || "", answer: kind.includes("ASK") ? result : null, artifacts: items || [] } });
    button.textContent = response?.state === "done" ? "Saved" : "Try again"; button.disabled = response?.state === "done";
  };
}

chrome.storage.session.onChanged.addListener((changes) => { if (changes.last) { showView("home"); renderCurrent(); } if (changes.libraryChanged && !byId("library").hidden) renderLibrary(); });

document.querySelectorAll("[data-kind]").forEach((button) => { button.onclick = () => { activeKind = button.dataset.kind; document.querySelectorAll("[data-kind]").forEach((item) => item.classList.toggle("active", item === button)); renderLibrary(); }; });
byId("search").oninput = renderLibrary;

async function renderLibrary() {
  objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  const terms = byId("search").value.toLowerCase().split(/\s+/).filter(Boolean);
  const moments = (await DB.all("moments")).sort((a, b) => b.createdAt - a.createdAt).filter((moment) => {
    if (activeKind !== "all" && moment.kind !== activeKind) return false;
    const searchable = [moment.title, moment.videoTitle, moment.channel, moment.question, moment.answer?.answer, moment.transcript, ...(moment.tags || []), ...(moment.artifacts || []).map((item) => item.content)].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const grid = byId("libraryGrid");
  if (!moments.length) { grid.innerHTML = `<div class="empty">${terms.length || activeKind !== "all" ? "No matching moments." : "Saved boxes and focused clips will appear here."}</div>`; return; }
  grid.innerHTML = "";
  moments.forEach((moment) => {
    const card = document.createElement("article"); card.className = "moment"; card.dataset.id = moment.id;
    const blob = moment.crop || moment.thumbnail;
    const source = blob ? URL.createObjectURL(blob) : ""; if (source) objectUrls.push(source);
    card.innerHTML = `${source ? `<div class="thumb-wrap"><img src="${source}" alt="">${moment.kind === "clip" ? `<span class="clip-badge">${formatTime(moment.endSec - moment.startSec)} clip</span>` : ""}</div>` : ""}<div class="moment-body"><div class="moment-title">${safe(moment.title || moment.videoTitle)}</div><div class="moment-meta">${formatTime(moment.startSec)} · ${safe(moment.channel || "YouTube")}</div></div>`;
    card.onclick = () => openDetail(moment);
    grid.appendChild(card);
  });
}

async function openDetail(moment) {
  openMoment = moment;
  const blob = moment.crop || moment.thumbnail;
  const source = blob ? URL.createObjectURL(blob) : ""; if (source) objectUrls.push(source);
  const answer = moment.answer || {};
  byId("detailBody").innerHTML = `${source ? `<img class="detail-image" src="${source}" alt="Saved moment">` : ""}<h1 class="detail-title">${safe(moment.title)}</h1><div class="detail-source">${safe(moment.videoTitle)} · ${formatTime(moment.startSec)}${moment.endSec != null ? `–${formatTime(moment.endSec)}` : ""}</div>${answer.answer ? `<div class="detail-answer"><p class="lead">${safe(answer.answer)}</p>${factGroup("Observed", "observed", answer.observed)}${factGroup("Inferred", "inferred", answer.inferred)}${factGroup("Can't tell", "cannot", answer.cannotTell)}</div>` : ""}${artifactsHtml(moment.artifacts)}<div class="action-row"><button id="detailWatch" class="primary">Watch again</button><button id="detailDelete" class="secondary danger">Delete</button></div>`;
  bindArtifacts(byId("detailBody"), moment.artifacts || []);
  byId("detailWatch").onclick = () => seek(moment.videoId, moment.startSec);
  byId("detailDelete").onclick = async () => { if (!confirm("Delete this saved moment?")) return; await DB.del("moments", moment.id); openMoment = null; showView("library"); };
  showView("detail");
}
byId("detailBack").onclick = () => showView("library");

const blobToDataUrl = (blob) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
byId("export").onclick = async () => {
  const moments = await Promise.all((await DB.all("moments")).map(async (moment) => ({ ...moment, crop: moment.crop ? await blobToDataUrl(moment.crop) : null, thumbnail: moment.thumbnail ? await blobToDataUrl(moment.thumbnail) : null })));
  const data = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), videos: await DB.all("videos"), moments }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(data); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "billy-library.json"; anchor.click(); URL.revokeObjectURL(url);
};

chrome.storage.local.get(["apiKey", "modelCache"], (stored) => {
  if (stored.apiKey) byId("key").placeholder = "Saved securely";
  if (stored.modelCache?.name) { byId("keyStatus").textContent = `Ready · ${stored.modelCache.name}`; byId("keyStatus").className = "status-line good"; }
  if (!stored.apiKey) showView("settings");
});
byId("saveKey").onclick = async () => {
  const key = byId("key").value.trim();
  if (!/^(AIza|AQ\.)[\w.-]{20,}$/.test(key)) { byId("keyStatus").textContent = "Paste the complete Gemini key (starts with AIza or AQ.)."; byId("keyStatus").className = "status-line bad"; return; }
  await chrome.storage.local.set({ apiKey: key }); await chrome.storage.local.remove("modelCache"); byId("key").value = ""; byId("key").placeholder = "Saved securely";
  byId("keyStatus").textContent = "Testing…"; byId("keyStatus").className = "status-line";
  const result = await send({ t: "TEST_KEY" });
  byId("keyStatus").textContent = result?.ok ? `Key works · ${result.model}` : (result?.error || result?.message || "Billy did not answer."); byId("keyStatus").className = `status-line ${result?.ok ? "good" : "bad"}`;
};

byId("runDiagnostics").onclick = async () => {
  const diagnostics = byId("diagnostics"); diagnostics.innerHTML = `<p class="muted">Running checks…</p>`;
  const [ping, tabs, storage] = await Promise.all([send({ t: "PING" }), chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []), (async () => { try { const id = `diag-${Date.now()}`; await DB.put("diag", { id, ok: true }); const row = await DB.get("diag", id); await DB.del("diag", id); return !!row?.ok; } catch { return false; } })()]);
  const activeTab = tabs[0]; const capture = activeTab?.id ? await chrome.tabs.sendMessage(activeTab.id, { t: "DIAG" }).catch(() => null) : null;
  const keyTest = await send({ t: "TEST_KEY" });
  const checks = [
    ["Billy messaging", !!ping?.ok, ping?.ok ? "ready" : "not responding"], ["Local library", storage, storage ? "read and write ready" : "storage failed"],
    ["YouTube video", !!capture?.onVideo, capture?.onVideo ? "found" : "open a YouTube video"], ["Frame capture", !!capture?.frame && !capture?.black, capture?.black ? "video returned a black frame" : capture?.frame ? "ready" : "not available"],
    ["Focus crop", !!capture?.crop, capture?.crop ? "math passed" : "not checked"], ["Captions", !!capture?.captions, capture?.captions ? `${capture.captions} lines · ${capture.captionsSource}` : "frames only"],
    ["Gemini key", !!keyTest?.ok, keyTest?.ok ? keyTest.model : (keyTest?.error || "not ready")],
  ];
  diagnostics.innerHTML = checks.map(([name, ok, detail]) => `<div class="check"><span>${safe(name)}<br><small class="muted">${safe(detail)}</small></span><b class="${ok ? "good" : "bad"}">${ok ? "✓" : "×"}</b></div>`).join("");
  diagnosticsText = checks.map(([name, ok, detail]) => `${ok ? "PASS" : "CHECK"} — ${name}: ${detail}`).join("\n"); byId("copyDiagnostics").hidden = false;
};
byId("copyDiagnostics").onclick = async () => { await navigator.clipboard.writeText(diagnosticsText); byId("copyDiagnostics").textContent = "Copied"; };

renderCurrent();