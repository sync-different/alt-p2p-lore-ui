/**
 * Saved sessions, as the frontend sees them.
 *
 * Note what is absent: the PSK. It lives in the OS keychain and is read only by Rust when
 * starting a tunnel, so it never crosses into JavaScript at all. `hasKey` is how the UI
 * knows one is stored without ever holding it.
 */

import { invoke } from "@tauri-apps/api/core";

/** How a host is reached. The tunnel is a transport detail, not the organising principle. */
export type HostKind = "p2p" | "direct";

export interface SessionConfig {
  id: string;
  name: string;
  /** alt-p2p rendezvous name, given by whoever runs the host. */
  session_id: string;
  server: string;
  loreserver_port: number;
  /** Fixed by the host's advertised auth_url; null when no sign-in is needed. */
  identity_port: number | null;
  allow_relay: boolean;
  /**
   * Skip hole punching and go straight to the relay. Optional, defaulting to false, so a host
   * saved before this existed keeps its behaviour. Distinct from `allow_relay`, which permits a
   * fallback only *after* a punch fails — a punch can succeed and still yield a carrier that
   * passes no traffic, and there is no fallback from a success.
   */
  force_relay?: boolean;
  /** Defaults to "p2p" for configurations written before direct hosts existed. */
  kind?: HostKind;
  /** Direct hosts only: where the loreserver is. P2P derives it from the forwarded port. */
  base_url?: string | null;
  /** Direct hosts only: where its tokens are filed. */
  auth_url?: string | null;
}

export const loadSessions = () => invoke<SessionConfig[]>("load_sessions");
export const saveSession = (config: SessionConfig, psk: string | null) =>
  invoke<SessionConfig[]>("save_session", { config, psk });
export const deleteSession = (id: string) => invoke<SessionConfig[]>("delete_session", { id });
export const hasPsk = (sessionId: string) => invoke<boolean>("has_psk", { sessionId });
export const connectSession = (sessionId: string) =>
  invoke<string>("connect_session", { sessionId });

/**
 * The URL a working copy on this host dials — and the identity of a host.
 *
 * Derived for P2P rather than stored: the tunnel forwards a loopback port, and a stored copy
 * would be a second answer to drift from the port actually in use.
 */
export function hostBaseUrl(h: SessionConfig): string {
  return (h.kind ?? "p2p") === "direct"
    ? (h.base_url ?? "")
    : `grpc://127.0.0.1:${h.loreserver_port}`;
}

/** Where this host's tokens are filed, or null when it needs no sign-in. */
export function hostAuthUrl(h: SessionConfig): string | null {
  if ((h.kind ?? "p2p") === "direct") {
    const u = h.auth_url?.trim();
    return u ? u : null;
  }
  return h.identity_port != null ? `https://127.0.0.1:${h.identity_port}` : null;
}

/**
 * `host:port` from a URL, which is what decides whether two URLs mean the same host.
 *
 * Compared rather than the whole string because a working copy's `remote_url` and a host's
 * base URL are written by different programs — trailing slashes and paths differ, the
 * authority does not.
 */
export function authorityOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const rest = url.includes("://") ? url.split("://")[1] : url;
  const authority = rest.split("/")[0].trim();
  return authority || null;
}

/** Does this host serve that working copy? */
export function hostServes(h: SessionConfig, remoteUrl: string | null | undefined): boolean {
  const a = authorityOf(hostBaseUrl(h));
  const b = authorityOf(remoteUrl);
  return a != null && a === b;
}
