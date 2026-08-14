import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Prerequisites as Prereqs } from "../types/ipc";

/**
 * Startup self-check (spec R3).
 *
 * The app bundles everything, so this answers "did my install arrive intact?" — not
 * "have you installed the dependencies?". That shapes the wording: an artist reading a
 * failure here cannot fix it by installing something, so the copy points at reinstalling
 * rather than at a missing tool they have never heard of.
 *
 * It stays out of the way when all is well: a single quiet line, not a dialog to dismiss.
 */
export function Prerequisites() {
  const [state, setState] = useState<Prereqs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<Prereqs>("check_prerequisites")
      .then((r) => alive && setState(r))
      // A rejected invoke means the backend itself failed, which is different from a
      // tool being missing — say so rather than showing an empty list.
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="px-3 py-2 text-danger">
        Could not run the startup check: <span className="selectable">{error}</span>
      </div>
    );
  }

  if (!state) {
    return <div className="px-3 py-2 text-ink-2">Checking components…</div>;
  }

  const failed = state.tools.filter((t) => !t.ok);

  return (
    <div className="border-t border-line">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${state.all_ok ? "bg-ok" : "bg-danger"}`}
          aria-hidden
        />
        <span className="text-ink-1">
          {state.all_ok ? "All prerequisites ready" : `${failed.length} prerequisite problem${failed.length > 1 ? "s" : ""}`}
        </span>
        <span className="ml-auto text-ink-2">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <table className="w-full">
            <tbody>
              {state.tools.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="py-1 pr-3 whitespace-nowrap text-ink-1">{t.name}</td>
                  <td className="py-1 selectable font-mono text-[11px] text-ink-2">
                    {t.ok ? t.version : <span className="text-danger">{t.problem}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {state.build_manifest && (
            <p className="mt-2 text-[11px] text-ink-2 selectable">
              Build {state.build_manifest.triple} · {state.build_manifest.jar.file}
            </p>
          )}
          {!state.build_manifest && (
            <p className="mt-2 text-[11px] text-ink-2">
              Development run — using local tools rather than the bundled ones.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
