/**
 * Types crossing the Rust <-> React boundary.
 *
 * Rust serialises with serde in snake_case; these mirror the wire shape exactly. Where a
 * field would read badly in React, rename it at the boundary in the hook rather than here,
 * so this file stays a faithful description of what actually arrives.
 */

export interface ToolStatus {
  /** Stable key: "lore" | "alt-p2p-lore" | "java". */
  id: string;
  name: string;
  ok: boolean;
  version: string | null;
  /** Present only when ok is false, phrased for a non-technical reader. */
  problem: string | null;
}

export interface Prerequisites {
  all_ok: boolean;
  tools: ToolStatus[];
  /** What fetch-deps.sh recorded at build time; absent in an unbundled dev run. */
  build_manifest: BuildManifest | null;
}

export interface BuildManifest {
  generated: string;
  triple: string;
  lore: { version: string; arch: string; source: string };
  jar: { file: string };
  jre: { version: string };
}

export type TunnelState =
  | "starting"
  | "running"
  | { stopped: { reason: string } };

export interface TunnelInfo {
  id: string;
  session_id: string;
  loreserver_port: number;
  /** Fixed by the host's advertised auth_url, not chosen by us. See PLAN.md O1. */
  identity_port: number | null;
  state: TunnelState;
}
