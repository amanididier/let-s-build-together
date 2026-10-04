// Shared local database (IndexedDB) used by background + side panel.
const DB = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open("billy", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ["videos", "moments", "diag"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: (s) => run(s, "readonly", (st) => st.getAll()),
    get: (s, k) => run(s, "readonly", (st) => st.get(k)),
    put: (s, v) => run(s, "readwrite", (st) => st.put(v)),
    del: (s, k) => run(s, "readwrite", (st) => st.delete(k)),
  };
})();

const KIND_TO_TYPE = { url: "website", command: "command", code: "code", path: "command", email: "note", text: "note" };

// p = CapturePayload, extra = { title, type, question, answer, artifacts, tags }
async function saveMoment(p, extra = {}) {
  const now = Date.now();
  const crop = await (await fetch(p.cropB64)).blob();
  await DB.put("videos", { id: p.videoId, title: p.titleGuess, channel: p.channel || "", url: `https://www.youtube.com/watch?v=${p.videoId}`, lastWatchedAt: now });
  const m = {
    id: crypto.randomUUID(), videoId: p.videoId, videoTitle: p.titleGuess, channel: p.channel || "", kind: "image",
    startSec: p.timestampSec, box: p.box, crop, transcript: p.transcriptWindow || "",
    title: extra.title || `${p.titleGuess} @ ${Math.floor(p.timestampSec / 60)}:${String(p.timestampSec % 60).padStart(2, "0")}`,
    type: extra.type || "note", tags: extra.tags || [], question: extra.question || "", answer: extra.answer || null,
    artifacts: extra.artifacts || [], createdAt: now, updatedAt: now, syncStatus: "pending",
  };
  await DB.put("moments", m);
  return m;
}
