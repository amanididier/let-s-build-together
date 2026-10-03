// Billy background: the ONLY place that talks to Gemini.
const MODEL = "gemini-2.5-flash"; // check current Flash model in AI Studio
const API = (k) => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(k)}`;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const TYPES = ["inspiration","visual_step","code","command","website","tool","idea","note","learning"];
const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    observed: { type: "array", items: { type: "string" } },
    inferred: { type: "array", items: { type: "string" } },
    cannotTell: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "object", properties: { text: { type: "string" }, timestampSec: { type: "number" } }, required: ["text"] } },
    copyBlocks: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["code","command","url","text"] }, language: { type: "string" }, content: { type: "string" } }, required: ["kind","content"] } },
    suggestedDiscovery: { type: "object", properties: { title: { type: "string" }, type: { type: "string", enum: TYPES }, tags: { type: "array", items: { type: "string" } } }, required: ["title","type","tags"] }
  },
  required: ["answer","observed","inferred","cannotTell","suggestedDiscovery"]
};

// Strict validation (Zod-equivalent) before anything reaches UI/DB.
function validate(o) {
  const strs = (a) => Array.isArray(a) && a.every((s) => typeof s === "string");
  if (!o || typeof o.answer !== "string" || !strs(o.observed) || !strs(o.inferred) || !strs(o.cannotTell)) throw new Error("bad shape");
  const sd = o.suggestedDiscovery;
  if (!sd || typeof sd.title !== "string" || !TYPES.includes(sd.type) || !strs(sd.tags)) throw new Error("bad discovery");
  o.steps = (o.steps || []).filter((s) => s && typeof s.text === "string");
  o.copyBlocks = (o.copyBlocks || []).filter((b) => b && typeof b.content === "string" && ["code","command","url","text"].includes(b.kind));
  return o;
}

const P2 = `You are Billy, watching a video with the user. Inputs: (1) CROP, the exact area the user pointed at; (2) the CURRENT FRAME and some frames before the pause; (3) TRANSCRIPT within ±30 s; (4) title, channel, timestamp; (5) the user's QUESTION. Answer the question about the crop, using the other inputs to understand what happened just before.
Rules: separate observed (clearly visible or spoken) from inferred (start each with "Probably"). If text is too small, blurry, or the action isn't visible, put it in cannotTell, never guess. Never invent a click, setting, command or code. Exact commands/code go in copyBlocks, copied character-for-character from what is visible; if a character is unclear, say so. For silent procedures, give numbered steps with approximate timestamps. Be short and plain. Output JSON only.`;

const b64 = (dataUrl) => ({ inline_data: { mime_type: "image/jpeg", data: dataUrl.split(",")[1] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(body) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("Add your Gemini key in Settings first.");
  for (let i = 0; i < 3; i++) {
    const r = await fetch(API(apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { if (i < 2) { await sleep(2000 * 2 ** i); continue; } throw new Error("Gemini is busy or your free-tier limit is reached. Try again in a minute."); }
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `Gemini error ${r.status}`);
    const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) throw new Error("Gemini returned nothing (it may have refused).");
    return text;
  }
}

async function ask(p) {
  const parts = [
    { text: P2 },
    { text: `Video: "${p.title}" by ${p.channel}. Paused at ${p.timestampSec}s.` },
    { text: "CROP:" }, b64(p.crop),
    { text: "CURRENT FRAME:" }, b64(p.current),
    ...p.frames.flatMap((f, i) => [{ text: `FRAME -${(p.frames.length - i) * 2}s:` }, b64(f)]),
    { text: `TRANSCRIPT ±30s:\n${p.transcript || "(no transcript available — rely on frames and say so)"}` },
    { text: `QUESTION: ${p.question}` }
  ];
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await gemini(body);
    try { return validate(JSON.parse(text)); } catch { if (attempt) throw new Error("Billy got a malformed answer. Please try again."); }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "capture") {
    chrome.storage.session.set({ pending: { ...msg.data, tabId: sender.tab.id } });
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    reply({ ok: true });
  }
  if (msg.type === "seek") {
    chrome.tabs?.sendMessage?.(msg.tabId, msg);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === "ask") port.postMessage({ ok: true, result: await ask(msg.data) });
      if (msg.type === "testKey") {
        await gemini({ contents: [{ parts: [{ text: "Reply with the word ok." }] }] });
        port.postMessage({ ok: true });
      }
    } catch (e) { port.postMessage({ ok: false, error: e.message }); }
  });
});
