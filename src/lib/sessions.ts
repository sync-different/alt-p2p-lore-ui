/**
 * Saved sessions, as the frontend sees them.
 *
 * Note what is absent: the PSK. It lives in the OS keychain and is read only by Rust when
 * starting a tunnel, so it never crosses into JavaScript at all. `hasKey` is how the UI
 * knows one is stored without ever holding it.
 */

import { invoke } from "@tauri-apps/api/core";

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
}

export const loadSessions = () => invoke<SessionConfig[]>("load_sessions");
export const saveSession = (config: SessionConfig, psk: string | null) =>
  invoke<SessionConfig[]>("save_session", { config, psk });
export const deleteSession = (id: string) => invoke<SessionConfig[]>("delete_session", { id });
export const hasPsk = (sessionId: string) => invoke<boolean>("has_psk", { sessionId });
export const connectSession = (sessionId: string) =>
  invoke<string>("connect_session", { sessionId });
