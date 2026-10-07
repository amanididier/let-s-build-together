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
  if (name !== "detail") clearInterval(flipTimer);
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

const toDataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
let flipTimer = null;

async function openDetail(moment) {
  openMoment = moment; clearInterval(flipTimer);
  const blob = moment.crop || moment.thumbnail;
  const source = blob ? URL.createObjectURL(blob) : ""; if (source) objectUrls.push(source);
  const frames = (moment.samples || []).map((s) => { const u = URL.createObjectURL(s.image); objectUrls.push(u); return { u, t: s.tSec }; });
  const answer = moment.answer || {};
  const isClip = moment.kind === "clip";
  byId("detailBody").innerHTML = `${source ? `<img id="detailImg" class="detail-image" src="${source}" alt="Saved moment">` : ""}${frames.length > 1 ? `<div class="action-row"><button id="flip" class="secondary">▶ Play frames</button><span id="flipTime" class="status-line"></span></div><input id="flipBar" type="range" min="0" max="${frames.length - 1}" value="0" style="width:100%">` : ""}<h1 class="detail-title">${safe(moment.title)}</h1><div class="detail-source">${safe(moment.videoTitle)} · ${formatTime(moment.startSec)}${moment.endSec != null ? `–${formatTime(moment.endSec)}` : ""}</div>
  <div class="key-row"><input id="detailQ" placeholder="${isClip ? "Ask about this clip…" : "Ask about this moment…"}"><button id="detailAsk">Ask</button></div><div id="detailAskStatus" class="status-line"></div>
  ${answer.answer ? `<div class="detail-answer">${moment.question ? `<p class="question">You asked: ${safe(moment.question)}</p>` : ""}<p class="lead">${safe(answer.answer)}</p>${factGroup("Observed", "observed", answer.observed)}${factGroup("Inferred", "inferred", answer.inferred)}${factGroup("Can't tell", "cannot", answer.cannotTell)}${answer.steps?.length ? `<div class="fact-group"><h3>Steps</h3><ol class="steps">${answer.steps.map((st) => `<li>${safe(st.text)}</li>`).join("")}</ol></div>` : ""}</div>` : ""}${artifactsHtml(moment.artifacts)}<div class="action-row"><button id="detailWatch" class="primary">Watch at ${formatTime(moment.startSec)}</button><button id="detailDelete" class="secondary danger">Delete</button></div>`;
  bindArtifacts(byId("detailBody"), moment.artifacts || []);
  if (frames.length > 1) {
    let i = 0;
    const show = (n) => { i = n; byId("detailImg").src = frames[i].u; byId("flipBar").value = i; byId("flipTime").textContent = `${formatTime(frames[i].t)} · frame ${i + 1}/${frames.length}`; };
    show(0);
    byId("flipBar").oninput = (e) => { clearInterval(flipTimer); flipTimer = null; byId("flip").textContent = "▶ Play frames"; show(Number(e.target.value)); };
    byId("flip").onclick = () => {
      if (flipTimer) { clearInterval(flipTimer); flipTimer = null; byId("flip").textContent = "▶ Play frames"; return; }
      byId("flip").textContent = "❚❚ Pause";
      flipTimer = setInterval(() => show((i + 1) % frames.length), 500);
    };
  }
  byId("detailAsk").onclick = async () => {
    const question = byId("detailQ").value.trim(), status = byId("detailAskStatus");
    if (!question) { status.textContent = "Type a question first."; status.className = "status-line bad"; return; }
    const btn = byId("detailAsk"); btn.disabled = true; status.textContent = "Billy is looking…"; status.className = "status-line";
    const base = { requestId: crypto.randomUUID(), videoId: moment.videoId, titleGuess: moment.videoTitle, channel: moment.channel, url: `https://www.youtube.com/watch?v=${moment.videoId}`, timestampSec: moment.startSec, transcriptWindow: moment.transcript, box: moment.box };
    let p;
    if (isClip) p = { ...base, kind: "clip", startSec: moment.startSec, endSec: moment.endSec, samples: await Promise.all((moment.samples || []).map(async (s) => ({ tSec: s.tSec, b64: await toDataUrl(s.image) }))) };
    else { const d = await toDataUrl(moment.crop); p = { ...base, cropB64: d, currentFrameB64: d, priorFramesB64: [] }; }
    const r = await send({ t: isClip ? "CLIP_ASK" : "ASK", saved: true, p, question });
    btn.disabled = false;
    if (r?.state !== "done") { status.textContent = r?.message || "Billy did not answer."; status.className = "status-line bad"; return; }
    const updated = { ...moment, question, answer: r.result, artifacts: [...(moment.artifacts || []), ...(r.result.copyBlocks || [])], updatedAt: Date.now() };
    await DB.put("moments", updated);
    openDetail(updated);
  };
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