import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Billy — watch YouTube together" },
      { name: "description", content: "Download the Billy Chrome extension: pause, point, ask, remember." },
      { property: "og:title", content: "Billy — watch YouTube together" },
      { property: "og:description", content: "Pause a YouTube video, draw a box, ask Billy. It remembers with the source." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function download() {
  fetch("/billy-extension.zip")
    .then((r) => {
      if (!r.ok) throw new Error(`Download failed: ${r.status}`);
      return r.blob();
    })
    .then((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = "billy-extension.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch((e) => alert(e.message));
}

function Index() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-sm uppercase tracking-widest text-muted-foreground">Watch · Point · Ask · Remember</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-tight">Billy</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          A buddy that watches YouTube with you. Pause, draw a box, ask — Billy separates what it saw from what it guesses, and remembers it with the exact moment.
        </p>
      </div>
      <button onClick={download} className="w-fit rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground">
        Download the extension
      </button>
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Unzip the file.</li>
        <li>Open chrome://extensions and turn on Developer mode.</li>
        <li>Click “Load unpacked” and pick the unzipped folder.</li>
        <li>Click the Billy icon, paste your Gemini key in Settings, then open a YouTube video.</li>
      </ol>
    </main>
  );
}
