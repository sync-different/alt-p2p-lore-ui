/**
 * The one colour convention, shared by everything that reports state.
 *
 *   green   working
 *   grey    not connected / neutral
 *   yellow  working, but degraded or unverified — needs attention, not alarm
 *   red     failed
 *
 * Defined once so a session tab and an Activity line cannot drift apart. Two components
 * each keeping their own map is how "connected" ends up green in one place and blue in
 * another, and the user has to learn two vocabularies for one fact.
 *
 * Relay is deliberately **yellow, not blue**: the connection works but is routed through the
 * coordinator — a different topology with a live dependency on it, worth surfacing. That is
 * "working, but worth noting". It is NOT a claim about speed: measured, relay has been the
 * *faster* path on some networks (see the carrier measurements). Giving it a colour of its own
 * would make it a fourth thing to learn rather than a shade of caution.
 */

import type { NoticeLevel, SessionStatus } from "../types/app";

export type StateTone = "ok" | "neutral" | "caution" | "bad";

export const TONE_DOT: Record<StateTone, string> = {
  ok: "bg-ok",
  neutral: "bg-ink-2",
  caution: "bg-warn",
  bad: "bg-danger",
};

export const TONE_TEXT: Record<StateTone, string> = {
  ok: "text-ok",
  neutral: "text-ink-2",
  caution: "text-warn",
  bad: "text-danger",
};

export function sessionTone(status: SessionStatus): StateTone {
  switch (status) {
    case "connected":
      return "ok";
    case "disconnected":
      return "neutral";
    // Connecting and relay are both "not fully right yet" rather than failures.
    case "connecting":
    case "relay":
      return "caution";
    case "error":
      return "bad";
  }
}

export function noticeTone(level: NoticeLevel): StateTone {
  switch (level) {
    case "success":
      return "ok";
    case "info":
      return "neutral";
    case "warn":
      return "caution";
    case "error":
      return "bad";
  }
}

export const SESSION_LABEL: Record<SessionStatus, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  connecting: "Connecting…",
  // Named rather than hidden: the route is a real dependency (the coordinator) worth surfacing —
  // not a speed claim; relay has measured faster than the direct path on some networks.
  relay: "Connected via relay — routed through the coordinator",
  error: "Problem",
};
