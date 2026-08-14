import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionStatus } from "../types/app";

/**
 * Live tunnels, mirrored from the Rust registry.
 *
 * The registry is authoritative — this is a read model kept in step by events, not a second
 * copy of the truth. That matters because a tunnel can die without anyone asking: the child
 * exits, Rust notices, and the UI must follow rather than continue drawing a connection
 * that ended.
 */

export type TunnelPhase =
  | "registering"
  | "waiting_peer"
  | "punching"
  | "handshaking"
  | "relay_tcp"
  | "relaying"
  | "connected"
  | "error"
  /** Stopped because the user asked. Not a failure — see TunnelPhase in event.rs. */
  | "stopped"
  | "other";

export type TunnelMode = "direct" | "relay" | "other";

export interface TunnelInfo {
  id: string;
  session_id: string;
  session_name: string;
  loreserver_port: number;
  identity_port: number | null;
  phase: TunnelPhase;
  mode: TunnelMode | null;
  url: string | null;
  error: string | null;
}

/** Which kind of event this is — see UpdateKind in supervisor.rs. */
export type UpdateKind = "status" | "ready" | "failed" | "exited";

export interface TunnelUpdate {
  kind: UpdateKind;
  id: string;
  /** Who this is about — attached by Rust so the feed can label every line. */
  session_id: string;
  session_name: string;
  phase: TunnelPhase;
  detail: string;
  mode: TunnelMode | null;
  url: string | null;
  error: string | null;
}

export interface TunnelConfig {
  session_name: string;
  session_id: string;
  psk: string;
  server: string;
  loreserver_port: number;
  identity_port: number | null;
  allow_relay: boolean;
}

/** Map a tunnel phase onto the shared session colour vocabulary. */
export function phaseToStatus(phase: TunnelPhase | undefined, mode?: TunnelMode | null): SessionStatus {
  if (!phase) return "disconnected";
  if (phase === "connected") return mode === "relay" ? "relay" : "connected";
  if (phase === "error") return "error";
  // A session the user closed is idle, not broken. Red here reads as "something went
  // wrong" about the thing they just did on purpose.
  if (phase === "stopped") return "disconnected";
  // Everything else is in-flight: registering, punching, handshaking, falling back.
  return "connecting";
}

export function useTunnels(onEvent?: (level: "info" | "success" | "warn" | "error", message: string, session?: string) => void) {
  const [tunnels, setTunnels] = useState<Map<string, TunnelInfo>>(new Map());

  /**
   * The notice callback, held by reference so that subscribing does not depend on it.
   *
   * `listen()` is asynchronous: an effect that re-runs tears the listener down and puts a
   * new one up a tick later, and anything the tunnel says in that gap is lost. With the
   * callback in the dependency list, a caller passing an inline arrow re-subscribed on
   * *every render* — which is exactly what happened: the tab went green because the
   * registry was re-read, while the Activity feed sat on "Connecting…" because the
   * `connected` event landed in one of those gaps. Making the caller memoise would work
   * until the next caller forgets; this cannot be got wrong from outside.
   */
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const refresh = useCallback(async () => {
    const list = await invoke<TunnelInfo[]>("list_tunnels");
    setTunnels(new Map(list.map((t) => [t.id, t])));
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen<TunnelUpdate>("tunnel://update", (e) => {
      const u = e.payload;
      setTunnels((prev) => {
        const next = new Map(prev);
        const existing = next.get(u.id);
        if (!existing) {
          // An update for a tunnel we have not seen: re-read rather than invent a row from
          // a partial update, since the registry knows its ports and session.
          void refresh();
          return prev;
        }
        next.set(u.id, {
          ...existing,
          phase: u.phase,
          // Mode and url only arrive with tunnel_ready; a later status must not erase them.
          mode: u.mode ?? existing.mode,
          url: u.url ?? existing.url,
          error: u.error,
        });
        return next;
      });

      // Every notice names its session. With several tunnels open, an unlabelled
      // "Connected" is worse than no notice at all — it invites acting on the wrong one.
      // Announce by *kind*, not by phase. Two events carry the connected phase — the peer
      // link coming up, and the local port being ready — so keying on the phase said
      // "Connected" twice. Only `ready` means the tunnel can be used, and only `ready`
      // knows whether the route is direct or relayed.
      const who = u.session_name || undefined;
      const notify = onEventRef.current;
      if (u.kind === "ready") {
        notify?.(u.mode === "relay" ? "warn" : "success", u.detail, who);
      } else if (u.kind === "exited" && u.phase === "stopped") {
        // Asked for. Worth a line, not worth a red one.
        notify?.("info", u.detail, who);
      } else if (u.kind === "failed" || u.kind === "exited") {
        notify?.("error", u.detail, who);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [refresh]);

  const start = useCallback(
    async (config: TunnelConfig) => {
      const id = await invoke<string>("start_tunnel", { config });
      await refresh();
      return id;
    },
    [refresh],
  );

  const stop = useCallback(
    async (id: string) => {
      await invoke<boolean>("stop_tunnel", { id });
      await refresh();
    },
    [refresh],
  );

  /**
   * The tunnel serving a given session.
   *
   * Prefers a live one over a stopped one. `find` alone returned whichever the map happened
   * to yield first — which left a tab red from a previous failed attempt while the current
   * connection was working perfectly.
   */
  const forSession = useCallback(
    (sessionId: string) => {
      const matching = [...tunnels.values()].filter((t) => t.session_id === sessionId);
      return matching.find((t) => t.phase !== "error") ?? matching[0];
    },
    [tunnels],
  );

  return { tunnels, start, stop, refresh, forSession };
}
