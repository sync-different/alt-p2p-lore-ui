/**
 * Reading a pasted token well enough to tell the user what they just pasted.
 *
 * Not verification — the signature is the host's business and this app holds no keys. The
 * point is narrower and worth doing: someone handed a JWT over chat has no way to tell an
 * expired one from a fresh one, or their own from a colleague's, and finding out by way of
 * a failed clone an hour later is the experience this whole milestone exists to prevent.
 *
 * Anything unreadable is reported as unreadable and still allowed through. The server is
 * the judge; refusing to send a token because we could not parse it would make this parser
 * an authority it has no right to be.
 */

export interface TokenPreview {
  /** Who the token says it is for. */
  subject?: string;
  /** Display name, when the issuer includes one. */
  name?: string;
  /** Repositories named in the token, if it scopes any. */
  resources?: string[];
  /** Expiry in epoch milliseconds. */
  expiresMs?: number;
  /** Why it could not be read, when it could not. */
  problem?: string;
}

function decodeSegment(seg: string): unknown {
  // base64url → base64, then pad. atob rejects the url alphabet and unpadded input.
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  // A name with a non-ASCII character would be mangled by a naive byte-to-char read.
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function previewToken(raw: string): TokenPreview {
  const token = raw.trim();
  if (!token) return { problem: "No token yet." };

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { problem: "This does not look like a token — a JWT has three parts separated by dots." };
  }

  let payload: Record<string, unknown>;
  try {
    payload = decodeSegment(parts[1]) as Record<string, unknown>;
  } catch {
    return { problem: "The token could not be read. It may have been truncated when copied." };
  }
  if (!payload || typeof payload !== "object") {
    return { problem: "The token could not be read." };
  }

  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const resources = Array.isArray(payload.resources)
    ? payload.resources.filter((r): r is string => typeof r === "string")
    : undefined;

  return {
    subject: str(payload.sub),
    name: str(payload.name) ?? str(payload.preferred_username),
    resources: resources?.length ? resources : undefined,
    // `exp` is seconds since the epoch, per the JWT spec — milliseconds here would put
    // every token fifty thousand years in the future and report them all as valid.
    expiresMs: typeof payload.exp === "number" ? payload.exp * 1000 : undefined,
  };
}

/** How the preview reads under the paste box. */
export function describePreview(p: TokenPreview, nowMs: number): { text: string; bad: boolean } {
  if (p.problem) return { text: p.problem, bad: true };

  const who = p.name ?? p.subject ?? "an unnamed subject";
  if (p.expiresMs == null) {
    return { text: `For ${who}. No expiry in the token.`, bad: false };
  }
  const minutes = Math.round((p.expiresMs - nowMs) / 60_000);
  if (minutes <= 0) {
    // Said before it is sent, not after it fails: pasting an expired token is the most
    // likely mistake here, because the one in the chat window is always the old one.
    return { text: `For ${who} — this token has already expired.`, bad: true };
  }
  const left = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h`;
  const scope = p.resources ? ` · ${p.resources.length} repository grant(s)` : "";
  return { text: `For ${who} · valid ${left}${scope}`, bad: false };
}
