import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LoreOutputLine, LoreTrace, OutputLine, TraceLine, TunnelLine } from "../lib/console";

/**
 * Every `lore` process the backend spawns, as it happens.
 *
 * **Recorded whether or not debug is switched on.** The console's value is being able to turn
 * it on *after* something went wrong and still see what led there; a switch that only helps
 * people who predicted they would need it is not much of a diagnostic. The cost is a handful
 * of small objects per user action, capped below.
 *
 * The subscription is deliberately free of dependencies — `listen()` is asynchronous, so an
 * effect that re-runs drops whatever arrives in the gap. That bug cost a milestone here once
 * already, in `useTunnels`; the fix is the same, and so is the reason it is written this way.
 */

/** Roughly a day of ordinary use. Unbounded would be a slow leak in an app left open all day. */
export const MAX_TRACES = 500;

export function useLoreTrace() {
  const [traces, setTraces] = useState<TraceLine[]>([]);
  /** Raw lines from tunnel processes — the jar's own account of a connection. */
  const [tunnel, setTunnel] = useState<TunnelLine[]>([]);
  /** Live output lines from lore commands — the phase narration of clone/commit/sync/push. */
  const [output, setOutput] = useState<OutputLine[]>([]);
  // Ids must be unique without depending on the clock: several commands can complete in the
  // same millisecond, and React keys that collide render the wrong rows.
  const seq = useRef(0);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    void listen<LoreTrace>("lore://command", (event) => {
      const line: TraceLine = { ...event.payload, id: `t${++seq.current}`, at: Date.now() };
      setTraces((prev) => [line, ...prev].slice(0, MAX_TRACES));
    }).then((un) => {
      // Unmounted before the listener resolved: unsubscribe immediately, or it outlives the
      // component and holds a reference to its setState forever.
      if (cancelled) un();
      else stop = un;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // The tunnel's own stdout and stderr. A separate subscription rather than a merged one,
  // because the two events carry different shapes and a single handler would have to
  // discriminate on a field before it could do anything useful with either.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    void listen<Omit<TunnelLine, "id" | "at">>("tunnel://output", (event) => {
      const line: TunnelLine = { ...event.payload, id: `o${++seq.current}`, at: Date.now() };
      setTunnel((prev) => [line, ...prev].slice(0, MAX_TRACES));
    }).then((un) => {
      if (cancelled) un();
      else stop = un;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // lore's own per-line output while a command runs — the same free-of-dependencies
  // subscription as above, for the same reason (a re-run must not drop lines in the gap).
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    void listen<LoreOutputLine>("lore://output", (event) => {
      const line: OutputLine = { ...event.payload, id: `l${++seq.current}`, at: Date.now() };
      setOutput((prev) => [line, ...prev].slice(0, MAX_TRACES));
    }).then((un) => {
      if (cancelled) un();
      else stop = un;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return {
    traces,
    tunnel,
    output,
    clear: () => {
      setTraces([]);
      setTunnel([]);
      setOutput([]);
    },
  };
}
