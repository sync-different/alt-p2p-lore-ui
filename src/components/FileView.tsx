import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fileDiff, formatSize, type FileDiff } from "../lib/repo";

/**
 * The main pane: what the selected file is, and how it differs.
 *
 * Diff first, contents second. Someone opening this app has almost always come to answer
 * "what did I change?" — the file's full text is context for that, not the subject.
 */

type FileContent =
  | { kind: "text"; text: string; truncated: boolean; lines: number }
  | { kind: "image"; data_uri: string; size: number }
  | { kind: "binary"; size: number; reason: string };

interface FileMeta {
  rel_path: string;
  size: number;
  modified_ms: number;
  content: FileContent;
}

const readFile = (root: string, rel: string) => invoke<FileMeta>("read_file", { root, rel });

function DiffBody({ diff }: { diff: FileDiff }) {
  // A changed binary must not fall through to "contents match". Lore cannot show lines for
  // it, but it has told us the file differs — and for an artist a changed asset is the
  // single most important thing this pane can report.
  if (diff.binary) {
    return (
      <div className="px-4 py-3">
        <p className="text-ink-1">This file has changed.</p>
        <p className="mt-1 text-[11px] text-ink-2">
          It is a binary file, so there are no lines to compare. Open the File tab to see it.
        </p>
      </div>
    );
  }

  if (!diff.has_changes) {
    return (
      <div className="px-4 py-3">
        {/* Not an error, and not a blank panel that looks like one. In the reference
            repository this is true of every one of 2163 "changed" files. */}
        <p className="text-ink-1">Marked as changed, but the contents match the last revision.</p>
        <p className="mt-1 text-[11px] text-ink-2">
          Lore lists this file as changed. Comparing it with the last revision finds no difference.
        </p>
      </div>
    );
  }

  return (
    <div className="font-mono text-[12px] leading-[18px]">
      <div className="sticky top-0 flex gap-3 border-b border-line bg-surface-1 px-3 py-1.5 text-[11px]">
        <span className="text-ok">+{diff.added}</span>
        <span className="text-danger">−{diff.removed}</span>
        {diff.from && <span className="selectable truncate text-ink-2">{diff.from}</span>}
      </div>
      {diff.lines.map((l, i) => {
        const style =
          l.kind === "added"
            ? "bg-ok/10 text-ok"
            : l.kind === "removed"
              ? "bg-danger/10 text-danger"
              : l.kind === "hunk_header"
                ? "bg-surface-2 text-ink-2"
                : l.kind === "file_header"
                  ? "text-ink-2"
                  : "text-ink-1";
        const marker = l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " ";
        return (
          <div key={i} className={`selectable flex whitespace-pre-wrap px-3 ${style}`}>
            {(l.kind === "added" || l.kind === "removed" || l.kind === "context") && (
              <span className="mr-2 shrink-0 select-none opacity-60">{marker}</span>
            )}
            <span className="min-w-0 break-all">{l.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Why a diff could not be produced.
 *
 * The common cause is worth naming rather than dumping: comparing a file needs the *base
 * revision's* contents, and those live on the host unless they happen to be cached locally.
 * With no connection, Lore cannot fetch them — so this is a connection problem wearing a
 * diff problem's clothes, and saying so is the difference between an actionable message and
 * a stack trace.
 */
function DiffUnavailable({ error }: { error: string }) {
  const disconnected = /disconnected from server|address not found/i.test(error);

  return (
    <div className="px-4 py-3">
      {disconnected ? (
        <>
          <p className="text-ink-1">Cannot compare this file while disconnected.</p>
          <p className="mt-1 text-[11px] text-ink-2">
            Comparing needs the previous version of the file, which is stored on the host.
            Connect to the session that serves this repository and try again.
          </p>
        </>
      ) : (
        <p className="text-ink-1">This file could not be compared.</p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] text-ink-2 hover:text-ink-1">
          Details
        </summary>
        <pre className="selectable mt-1 whitespace-pre-wrap break-all text-[11px] text-ink-2">
          {error}
        </pre>
      </details>
    </div>
  );
}

function ContentBody({ meta }: { meta: FileMeta }) {
  const c = meta.content;

  if (c.kind === "image") {
    return (
      <div className="flex flex-col items-center gap-3 p-4">
        {/* Checkerboard so transparent art does not vanish into the dark background —
            a black icon on a black panel looks like a failed load. */}
        <div
          className="rounded border border-line p-2"
          style={{
            backgroundImage:
              "linear-gradient(45deg, #2c313a 25%, transparent 25%), linear-gradient(-45deg, #2c313a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2c313a 75%), linear-gradient(-45deg, transparent 75%, #2c313a 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
          }}
        >
          <img src={c.data_uri} alt={meta.rel_path} className="max-h-[60vh] max-w-full" />
        </div>
        <p className="text-[11px] text-ink-2">{formatSize(c.size)}</p>
      </div>
    );
  }

  if (c.kind === "binary") {
    return (
      <div className="p-4">
        <p className="text-ink-1">{c.reason}</p>
        <p className="mt-1 text-[11px] text-ink-2">
          There is nothing readable to show for this kind of file.
        </p>
      </div>
    );
  }

  return (
    <pre className="selectable overflow-auto p-3 font-mono text-[12px] leading-[18px] text-ink-1">
      {c.text}
      {c.truncated && <span className="text-warn">… truncated</span>}
    </pre>
  );
}

export function FileView({ root, rel }: { root: string; rel: string | null }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"diff" | "content">("diff");

  useEffect(() => {
    if (!rel) {
      setMeta(null);
      setDiff(null);
      setDiffError(null);
      return;
    }
    let alive = true;
    setError(null);
    setMeta(null);
    setDiff(null);
    setDiffError(null);

    // Both run for every selection: a file can be binary *and* changed, and the tabs
    // should not each wait for their own click to start loading.
    readFile(root, rel)
      .then((m) => alive && setMeta(m))
      .catch((e) => alive && setError(String(e)));

    // A diff failure must not hide the file — but it must not be swallowed either. An
    // earlier version discarded it, which left this pane saying "Comparing…" forever
    // whenever `lore diff` failed. Silence is the one response that cannot be acted on.
    fileDiff(root, rel)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setDiffError(String(e)));

    return () => {
      alive = false;
    };
  }, [root, rel]);

  if (!rel) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-ink-2">Select a file to view it.</p>
      </div>
    );
  }

  if (error) {
    return <p className="selectable p-4 text-danger">{error}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <button
          onClick={() => setTab("diff")}
          className={`rounded px-2 py-0.5 ${tab === "diff" ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          Changes
          {diff?.has_changes && (
            <span className="ml-1.5 text-[11px] text-ok">+{diff.added}</span>
          )}
        </button>
        <button
          onClick={() => setTab("content")}
          className={`rounded px-2 py-0.5 ${tab === "content" ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          File
        </button>
        <span className="ml-auto selectable truncate text-[11px] text-ink-2" title={rel}>
          {rel}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "diff" ? (
          diffError ? (
            <DiffUnavailable error={diffError} />
          ) : diff ? (
            <DiffBody diff={diff} />
          ) : (
            <p className="px-4 py-3 text-ink-2">Comparing…</p>
          )
        ) : meta ? (
          <ContentBody meta={meta} />
        ) : (
          <p className="px-4 py-3 text-ink-2">Loading…</p>
        )}
      </div>
    </div>
  );
}
