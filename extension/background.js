// Billy background: the ONLY place that reads the key and talks to Gemini. Also does local saves.
importScripts("db.js");

const FALLBACK_MODEL = "gemini-3.5-flash"; // used only if model discovery fails
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TYPES = ["inspiration", "visual_step", "code", "command", "website", "tool", "idea", "note", "learning"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ---------- log (last 200 events) ----------
async function log(action, result, extra = {}) {
  const { log: l = [] } = await chrome.storage.local.get("log");
  l.push({ at: new Date().toISOString(), action, result, ...extra });
  await chrome.storage.local.set({ log: l.slice(-200) });
}

// ---------- errors ----------
const MESSAGES = {
  NO_KEY: "Add your Gemini key in Billy's Settings first.",
  AUTH: "Google rejected your key. Check it in Settings.",
  RATE_LIMIT: "Gemini's limit is reached for now. Try again in a minute.",
  MODEL_NOT_FOUND: "That Gemini model isn't available to your key.",
  TIMEOUT: "Gemini took too long to answer. Try again.",
  BAD_RESPONSE: "Billy got a confusing answer from Gemini. Try again.",
  NETWORK: "Couldn't reach Google. Check your internet.",
  BLOCKED: "Gemini refused to answer this one.",
};
class AIError extends Error { constructor(code, detail) { super(MESSAGES[code] + (detail ? ` (${detail})` : "")); this.code = code; } }

async function req(url, init, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); }
  catch (e) { throw new AIError(e.name === "AbortError" ? "TIMEOUT" : "NETWORK"); }
  finally { clearTimeout(t); }
}
async function fromHttp(r) {
  const j = await r.json().catch(() => ({}));
  const m = j?.error?.message || "";
  if (r.status === 429) return new AIError("RATE_LIMIT");
  if (r.status === 404 || /not found|no longer available|not supported/i.test(m)) return new AIError("MODEL_NOT_FOUND", m.slice(0, 120));
  if (r.status === 401 || r.status === 403 || /api key/i.test(m)) return new AIError("AUTH");
  return new AIError("BAD_RESPONSE", m.slice(0, 120) || `HTTP ${r.status}`);
}
async function key() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new AIError("NO_KEY");
  return apiKey;
}

// ---------- model selection: discover, never hard-code ----------
async function pickModel(force = false) {
  const s = await chrome.storage.local.get(["modelOverride", "modelCache"]);
  if (s.modelOverride) return s.modelOverride;
  if (!force && s.modelCache && Date.now() - s.modelCache.at < 864e5) return s.modelCache.name;
  const r = await req(`${BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": await key() } }, 10000);
  if (!r.ok) throw await fromHttp(r);
  const names = ((await r.json()).models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-\d/.test(n) && /flash/.test(n) && !/image|tts|live|audio|embed|thinking|8b|native/.test(n));
  const score = (n) => {
    const v = parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
    const unstable = /preview|exp/.test(n) ? 1 : 0, lite = /lite/.test(n) ? 1 : 0;
    return -unstable * 1000 + v * 10 - lite;
  };
  names.sort((a, b) => score(b) - score(a));
  const name = names[0] || FALLBACK_MODEL;
  await chrome.storage.local.set({ modelCache: { name, at: Date.now(), candidates: names.slice(0, 8) } });
  return name;
}

// WHY STREAMING: Chrome kills an extension service worker when a fetch() response takes more than
// 30 s to arrive. Thinking models send nothing until they finish, so long answers silently died with
// the worker. streamGenerateContent sends bytes (including short thought summaries) within seconds,
// and a keep-alive extension API call every 20 s stops the idle timer from firing.
async function keepAlive(promise) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try { return await promise; } finally { clearInterval(t); }
}

// idleMs = give up only if Google sends NOTHING for that long; hardMs stays under Chrome's 5-minute cap.
async function streamCall(model, k, body, idleMs, hardMs = 240000) {
  const c = new AbortController(), t0 = Date.now();
  let idle, ttfb = 0, text = "", buf = "";
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => c.abort(), idleMs); };
  const hard = setTimeout(() => c.abort(), hardMs);
  const lost = (e) => new AIError(e?.name === "AbortError" ? "TIMEOUT" : "NETWORK");
  const frame = (raw) => {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data || data === "[DONE]") return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new AIError("BAD_RESPONSE", String(j.error.message || "").slice(0, 120));
    if (j.promptFeedback?.blockReason) throw new AIError("BLOCKED");
    const cand = j.candidates?.[0];
    if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(cand?.finishReason)) throw new AIError("BLOCKED");
    for (const p of cand?.content?.parts || []) if (!p.thought && typeof p.text === "string") text += p.text;
  };
  arm();
  try {
    let r;
    try {
      r = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k }, body: JSON.stringify(body), signal: c.signal });
    } catch (e) { throw lost(e); }
    if (!r.ok) return { r };
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      let chunk; try { chunk = await reader.read(); } catch (e) { throw lost(e); }
      if (chunk.done) break;
      arm(); if (!ttfb) ttfb = Date.now() - t0;
      buf += dec.decode(chunk.value, { stream: true }).replace(/\r/g, "");
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { frame(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) frame(buf);
    if (!text) throw new AIError("BAD_RESPONSE", "empty");
    return { text, ttfb, ms: Date.now() - t0 };
  } finally { clearTimeout(idle); clearTimeout(hard); }
}

async function generate(body, idleMs = 90000) {
  return keepAlive((async () => {
    const k = await key();
    let model = await pickModel(), refetched = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await streamCall(model, k, body, idleMs);
      if (!out.r) return { ...out, model };
      const r = out.r, e = await fromHttp(r);
      if (r.status === 400 && body.generationConfig?.thinkingConfig && /thinking/i.test(e.message)) {
        delete body.generationConfig.thinkingConfig; continue; // model doesn't accept the thinking setting
      }
      if (e.code === "MODEL_NOT_FOUND" && !refetched) { refetched = true; model = await pickModel(true); continue; }
      if ((e.code === "RATE_LIMIT" || r.status >= 500) && attempt === 0) { await new Promise((s) => setTimeout(s, 2500)); continue; }
      throw e;
    }
    throw new AIError("BAD_RESPONSE");
  })());
}

// ---------- schemas + validators ----------
const S = { type: "string" }, SA = { type: "array", items: S };
const ASK_SCHEMA = {
  type: "object",
  properties: {
    answer: S, observed: SA, inferred: SA, cannotTell: SA,
    steps: { type: "array", items: { type: "object", properties: { text: S, timestampSec: { type: "number" } }, required: ["text"] } },
    copyBlocks: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["code", "command", "url", "text"] }, language: S, content: S }, required: ["kind", "content"] } },
    suggestedDiscovery: { type: "object", properties: { title: S, type: { type: "string", enum: TYPES }, tags: SA }, required: ["title", "type", "tags"] },
  },
  required: ["answer", "observed", "inferred", "cannotTell", "suggestedDiscovery"],
};
const KINDS = ["url", "command", "code", "text", "path", "email"];
const COPY_SCHEMA = {
  type: "object",
  properties: {
    artifacts: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: KINDS }, content: S, language: S,
      confidence: { type: "string", enum: ["high", "medium", "low"] }, uncertain: SA,
    }, required: ["kind", "content", "confidence"] } },
    note: S,
  },
  required: ["artifacts"],
};
const strs = (a) => Array.isArray(a) && a.every((s) => typeof s === "string");
function validAsk(o) {
  if (!o || typeof o.answer !== "string" || !strs(o.observed) || !strs(o.inferred) || !strs(o.cannotTell)) throw 0;
  const sd = o.suggestedDiscovery;
  if (!sd || typeof sd.title !== "string" || !TYPES.includes(sd.type) || !strs(sd.tags)) throw 0;
  o.steps = (o.steps || []).filter((s) => s && typeof s.text === "string");
  o.copyBlocks = (o.copyBlocks || []).filter((b) => b && typeof b.content === "string");
  return o;
}
function validCopy(o) {
  if (!o || !Array.isArray(o.artifacts)) throw 0;
  o.artifacts = o.artifacts.filter((a) => a && typeof a.content === "string" && KINDS.includes(a.kind))
    .map((a) => ({ ...a, confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "low", uncertain: strs(a.uncertain) ? a.uncertain : [] }));
  return o;
}

// ---------- prompts ----------
const P_ASK = `You are Billy, watching a video with the user. Inputs: CROP (the exact area the user boxed), the CURRENT FRAME, some earlier frames, the TRANSCRIPT within ±30 s, the video title and timestamp, and the user's QUESTION. Answer about the crop, using the other inputs to understand what happened just before.
Rules: separate observed (clearly visible or spoken) from inferred (start each with "Probably"). If text is too small, blurry, or the action isn't visible, put it in cannotTell — never guess. Never invent a click, setting, command or code. Exact commands/code go in copyBlocks, copied character-for-character; if a character is unclear, say so. For silent procedures give numbered steps with approximate timestamps. Be short and plain. JSON only.`;
const P_COPY = `You are Billy. The user boxed something in a video and pressed Copy. Inputs: CROP (the boxed area), the current frame, and the transcript within ±30 seconds. Return exactly what is written in the crop, character for character, as artifacts. Use the transcript only for context. Do not autocorrect, do not add "https://" unless visible, keep case and spacing. If a character is ambiguous, set confidence lower and describe it in "uncertain". If nothing readable is in the crop, return an empty artifacts list and explain in note. JSON only.`;
const P_CLIP = `You are Billy. The user focused on one region of a YouTube video over a short time range. Inputs are cropped samples in time order, timestamps, nearby transcript, source, and a QUESTION. Explain only what changes inside that region. Separate clearly observed facts from inferences. If samples are too sparse to explain the movement, say so in cannotTell and suggest a shorter focus. Never invent a click, setting, command, or hidden action. Give concise steps when visible. JSON only.`;

const img = (d) => ({ inline_data: { mime_type: "image/jpeg", data: d.split(",")[1] } });
const ctx = (p) => ({ text: `Video: "${p.titleGuess}" ${p.channel ? `by ${p.channel}` : ""}. Paused at ${p.timestampSec}s. URL ${p.url}` });
const tr = (p) => ({ text: `TRANSCRIPT ±30s:\n${p.transcriptWindow || "(no transcript available — rely on images and say so)"}` });

async function structured(parts, schema, check) {
  // Gemini 3.x "thinks" at high effort by default. Low thinking keeps it fast; includeThoughts makes it stream early bytes.
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingLevel: "low", includeThoughts: true } } };
  for (let i = 0; i < 2; i++) {
    const { text, model, ttfb, ms } = await generate(body);
    try { return { data: check(JSON.parse(text)), model, ttfb, ms }; } catch { if (i) throw new AIError("BAD_RESPONSE"); }
  }
}
const pauseAsk = (p, question) => structured([
  { text: P_ASK }, ctx(p), { text: "CROP:" }, img(p.cropB64), { text: "CURRENT FRAME:" }, img(p.currentFrameB64),
  ...(p.priorFramesB64 || []).flatMap((f, i, a) => [{ text: `FRAME ~${(a.length - i) * 2}s earlier:` }, img(f)]),
  tr(p), { text: `QUESTION: ${question}` },
], ASK_SCHEMA, validAsk);
const copyExtract = (p) => structured([
  { text: P_COPY }, ctx(p), { text: "CROP:" }, img(p.cropB64), { text: "CURRENT FRAME:" }, img(p.currentFrameB64), tr(p),
], COPY_SCHEMA, validCopy);
const clipAsk = (p, question) => structured([
  { text: P_CLIP }, ctx(p), { text: `FOCUS RANGE: ${p.startSec}s to ${p.endSec}s` },
  ...(p.samples || []).flatMap((sample) => [{ text: `CROP AT ${sample.tSec}s:` }, img(sample.b64)]),
  tr(p), { text: `QUESTION: ${question}` },
], ASK_SCHEMA, validAsk);

// ---------- actions ----------
const slim = (p) => ({ ...p, priorFramesB64: [], samples: (p.samples || []).slice(0, 8) }); // keep session storage small
async function setLast(v) { await chrome.storage.session.set({ last: { ...v, at: Date.now() } }); }

async function handle(msg, tabId) {
  const t0 = Date.now(), { p } = msg;
  try {
    if (!p) return { state: "error", message: "Billy did not receive the selected moment." };
    if (msg.t === "SAVE" || msg.t === "CLIP_SAVE") {
      const m = msg.t === "CLIP_SAVE" ? await saveClipMoment(p, msg.extra) : await saveMoment(p, msg.extra);
      await log(msg.t, "done", { id: p.requestId, ms: Date.now() - t0 });
      chrome.storage.session.set({ libraryChanged: Date.now() });
      return { state: "done", message: "Saved to your library", id: m.id };
    }
    if (msg.saved) {
      const r = msg.t === "CLIP_ASK" ? await clipAsk(p, msg.question) : await pauseAsk(p, msg.question);
      await log(msg.t, "done", { id: p.requestId, ms: Date.now() - t0, model: r.model, saved: true });
      return { state: "done", result: r.data, model: r.model };
    }
    await setLast({ kind: msg.t, state: "working", p: slim(p), question: msg.question, tabId });
    const r = msg.t === "ASK" ? await pauseAsk(p, msg.question) : msg.t === "CLIP_ASK" ? await clipAsk(p, msg.question) : await copyExtract(p);
    await setLast({ kind: msg.t, state: "done", p: slim(p), question: msg.question, tabId, result: r.data, model: r.model });
    await log(msg.t, "done", { id: p.requestId, ms: Date.now() - t0, model: r.model });
    const n = r.data.artifacts?.length;
    return { state: "done", message: msg.t === "COPY" ? (n ? `Found ${n} item${n > 1 ? "s" : ""} — see the side panel` : "Nothing readable in the box") : "Answer is in the side panel" };
  } catch (e) {
    const message = e instanceof AIError ? e.message : `Something broke: ${e?.message || e}`;
    if (msg.t !== "SAVE" && !msg.saved) await setLast({ kind: msg.t, state: "error", p: slim(p), question: msg.question, tabId, error: message });
    await log(msg.t, "error", { id: p?.requestId, ms: Date.now() - t0, code: e?.code, message });
    return { state: "error", message };
  }
}

async function testKey() {
  const t0 = Date.now();
  await key();
  await pickModel(true);
  // Same streaming path as real answers, with minimal thinking, so the test reflects reality and returns fast.
  const r = await generate({ contents: [{ role: "user", parts: [{ text: "Reply with the word ok." }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }, 30000);
  await log("TEST_KEY", "done", { model: r.model, ms: Date.now() - t0, ttfb: r.ttfb });
  return { model: r.model, ms: Date.now() - t0 };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (["ASK", "COPY", "CLIP_ASK"].includes(msg.t)) { if (sender.tab && !msg.saved) chrome.sidePanel.open({ tabId }).catch(() => {}); }
  if (["SAVE", "ASK", "COPY", "CLIP_SAVE", "CLIP_ASK"].includes(msg.t)) { handle(msg, tabId).then(reply); return true; }
  if (msg.t === "WATCH_GET") { chrome.storage.local.get("watchOn").then((r) => reply({ on: !!r.watchOn })); return true; }
  if (msg.t === "WATCH_SET") { chrome.storage.local.set({ watchOn: !!msg.on }).then(() => reply({ ok: true })); log("WATCH_SET", msg.on ? "on" : "off"); return true; }
  if (msg.t === "PING") { reply({ ok: true, at: Date.now() }); return; }
  if (msg.t === "TEST_KEY") {
    testKey().then((r) => reply({ ok: true, ...r })).catch(async (e) => {
      const message = e instanceof AIError ? e.message : String(e?.message || e);
      await log("TEST_KEY", "error", { code: e?.code, message });
      reply({ ok: false, error: message });
    });
    return true;
  }
});
