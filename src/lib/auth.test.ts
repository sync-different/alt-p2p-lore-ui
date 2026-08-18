import { describe, expect, it } from "vitest";
import {
  accountsAt,
  badgeLabel,
  identitiesAt,
  portOfAuthUrl,
  nameForId,
  expiryLabel,
  expiryTone,
  explainError,
  looksLikeUntrustedCa,
  humanDuration,
  looksLikeAuthFailure,
  needsSignIn,
  toExpiry,
  type Expiry,
} from "./auth";

/**
 * The vocabulary the sign-in badge speaks.
 *
 * The rule that matters more than any wording: a state the app cannot vouch for is never
 * shown as fine. Green is what lets someone start a long push, and a green light we cannot
 * justify is the failure this milestone exists to prevent.
 */

describe("expiry state", () => {
  const e = (state: Expiry["state"], minutes?: number): Expiry => ({ state, minutes });

  it("is green only when there is comfortable time left", () => {
    expect(expiryTone(e("valid", 300))).toBe("ok");
  });

  it("names who is signed in, not just how long is left", () => {
    // With several sessions open, *which account* is as much a part of the state as the
    // time remaining — and it is the thing that explains a permission error later.
    expect(expiryLabel(e("valid", 600), "ale")).toBe("Signed in as ale · 10h left");
    expect(expiryLabel(e("soon", 20), "ale")).toBe("Signed in as ale · expires in 20 min");
  });

  it("still reads correctly when the user is unknown", () => {
    expect(expiryLabel(e("valid", 600))).toBe("Signed in · 10h left");
  });

  it("warns rather than reassures when time is short", () => {
    expect(expiryTone(e("soon", 20))).toBe("warn");
    expect(expiryLabel(e("soon", 20))).toBe("Signed in · expires in 20 min");
  });

  it("treats an unreadable expiry as a warning, never as valid", () => {
    // The regression that would matter: a CLI format change turning every token green.
    expect(expiryTone(e("unknown"))).toBe("warn");
    expect(expiryTone(e("unknown"))).not.toBe("ok");
    expect(expiryLabel(e("unknown"))).toMatch(/unknown/i);
  });

  it("marks an expired token as an error and asks for a sign-in", () => {
    expect(expiryTone(e("expired", 5))).toBe("danger");
    expect(needsSignIn(e("expired", 5))).toBe(true);
    expect(needsSignIn(e("missing"))).toBe(true);
  });

  it("does not ask for a sign-in while one is working", () => {
    expect(needsSignIn(e("valid", 300))).toBe(false);
    expect(needsSignIn(e("soon", 5))).toBe(false);
  });

  it("reads the tagged enum Rust sends, and falls back to unknown", () => {
    expect(toExpiry({ state: "soon", minutes: 12 })).toEqual({ state: "soon", minutes: 12 });
    expect(toExpiry({ state: "missing" })).toEqual({ state: "missing", minutes: undefined });
    // Anything unrecognised must land on the cautious state, not the reassuring one.
    expect(toExpiry(null).state).toBe("unknown");
    expect(toExpiry("nonsense").state).toBe("unknown");
  });
});

describe("humanDuration", () => {
  it("uses the unit a person would use", () => {
    expect(humanDuration(45)).toBe("45 min");
    expect(humanDuration(60)).toBe("1h");
    expect(humanDuration(150)).toBe("2h 30m");
    expect(humanDuration(1500)).toBe("1d 1h");
  });

  it("never rounds remaining time down to nothing", () => {
    // "0 min left" beside a token that still works reads as broken.
    expect(humanDuration(0.4)).toBe("0 min");
    expect(humanDuration(-5)).toBe("0 min");
  });
});

describe("explainError", () => {
  it("names an expired sign-in instead of relaying the storage error", () => {
    const raw = "Operation not supported: authentication requires a configured auth endpoint";
    const out = explainError(raw);
    expect(out.message).toMatch(/expired/i);
    // The original is kept, not thrown away — it is what makes a report answerable.
    expect(out.detail).toBe(raw);
  });

  it("leaves an unrelated failure exactly as it was", () => {
    // Rewriting a network error as an auth problem sends someone to the wrong place, which
    // is the same fault in the other direction.
    const raw = "connection refused";
    expect(explainError(raw)).toEqual({ message: raw });
  });

  it("tells a missing grant apart from a dead token", () => {
    // Observed live: uitest, token valid for twelve hours, gets "Not authorized to access
    // repository". Sending that user to sign in again is a loop that cannot help — the fix
    // is a grant from the host, and the message has to say so.
    const out = explainError("[Error] Not authorized to access repository", "uitest");
    expect(out.message).toMatch(/no access to this repository/i);
    expect(out.message).toMatch(/uitest/);
    expect(out.message).not.toMatch(/your access to this host has expired/i);
    expect(out.detail).toContain("Not authorized");
    // The half that is easy to leave out: the host may already have fixed it.
    expect(out.message).toMatch(/cached/i);
    expect(out.canRefreshAccess).toBe(true);
  });

  it("still names the problem when it does not know who is signed in", () => {
    const out = explainError("permission denied");
    expect(out.message).toMatch(/no access to this repository/i);
  });

  it("keeps calling a dead token a dead token", () => {
    expect(explainError("status: Unauthenticated, message: token expired").message).toMatch(
      /expired/i,
    );
  });

  it("names the repository's own identity when that is what is missing", () => {
    // Found live: a clone carrying `identity = "u-87c4…"` in .lore/config.toml while that
    // user was signed out. lore says "No token stored" — true, and nothing about it points
    // at the repository. Reported as an expired session it sent the user to sign in again
    // as the user who *was* signed in, which could never have worked.
    const out = explainError(
      "Unable to check lock status while offline: No token stored",
      "uitest",
      "ale (u-87c4b8c8b7f44fc1)",
    );
    expect(out.message).toMatch(/set to act as ale/i);
    expect(out.message).not.toMatch(/expired/i);
    expect(out.detail).toContain("No token stored");
  });

  it("still says something useful when the repository is not pinned", () => {
    const out = explainError("No token stored");
    expect(out.message).toMatch(/identity this repository needs/i);
  });

  it("resolves an opaque id to a name when one is known", () => {
    const known = [{ user: "ale", user_id: "u-87c4" }, { user: "uitest", user_id: "u-99f5" }];
    expect(nameForId("u-87c4", known)).toBe("ale (u-87c4)");
    // Unknown ids are shown as they are rather than dropped — it is still the answer.
    expect(nameForId("u-zzz", known)).toBe("u-zzz");
  });

  it("recognises the wordings lore and gRPC actually produce", () => {
    for (const s of ["status: Unauthenticated, message: token expired", "HTTP 401 error"]) {
      expect(looksLikeAuthFailure(s)).toBe(true);
    }
    for (const s of ["no such file or directory", "the repository is locked by someone else"]) {
      expect(looksLikeAuthFailure(s)).toBe(false);
    }
  });
});

describe("badgeLabel", () => {
  const id = (user: string, expiresMs: number | null) => ({
    auth_url: "https://127.0.0.1:9443",
    resource: null,
    user,
    user_id: `u-${user}`,
    domains: [],
    expires_raw: null,
    expires_ms: expiresMs,
  });

  it("reads as before with a single identity", () => {
    expect(badgeLabel([id("ale", 1)], { state: "valid", minutes: 600 })).toBe(
      "Signed in as ale · 10h left",
    );
  });

  it("says whose clock it is when several are stored", () => {
    // Reported from testing: "when 2 auth tokens, shows 6h27min left, but that's only for 1
    // token." True — the soonest, since we cannot know which lore will use — but presented
    // as if it covered both, and the other may have twelve hours or none.
    const out = badgeLabel(
      [id("ale", 1_000), id("uitest", 9_000)],
      { state: "valid", minutes: 387 },
    );
    expect(out).toContain("ale, uitest");
    expect(out).toMatch(/ale expires in 6h 27m/);
  });

  it("shows only the pinned identity's clock when the workspace has chosen", () => {
    // Reported from testing: a workspace acting as uitest still read
    // "ale, uitest — ale expires in 5h52m". ale's clock has nothing to do with that work.
    const out = badgeLabel(
      [id("ale", 1_000), id("uitest", 9_000)],
      { state: "valid", minutes: 700 },
      "u-uitest",
    );
    expect(out).toBe("Signed in as uitest · 11h 40m left");
    expect(out).not.toContain("ale");
  });

  it("says plainly when the pinned identity is not signed in", () => {
    // The state behind "No token stored": every call from that workspace will fail.
    const out = badgeLabel([id("ale", 1_000)], { state: "missing" }, "u-uitest");
    expect(out).toMatch(/acting as u-uitest · not signed in/i);
  });

  it("names the one that expired, not the one that has time left", () => {
    const out = badgeLabel([id("uitest", 9_000), id("ale", 1_000)], { state: "expired", minutes: 30 });
    expect(out).toMatch(/ale expired 30 min ago/);
  });

  it("does not invent a countdown when nothing can be read", () => {
    const out = badgeLabel([id("ale", null), id("uitest", null)], { state: "unknown" });
    expect(out).toContain("ale, uitest");
    expect(out).toMatch(/expiry unknown/);
    expect(out).not.toMatch(/\d+h/);
  });
});

describe("identities are per host, not global", () => {
  // MODEL.md I2/I3: a host advertises one auth URL, and that URL holds many identities. So
  // "is this user signed in?" is only answerable *for a host* — and a workspace on host B
  // judged against host A's store looked healthy when it was not.
  const id = (user: string, authUrl: string, resource: string | null = null) => ({
    auth_url: authUrl,
    resource,
    user,
    user_id: `u-${user}`,
    domains: [],
    expires_raw: null,
    expires_ms: null,
  });

  const store = [
    id("ale", "https://127.0.0.1:9443"),
    id("uitest", "https://127.0.0.1:9443"),
    id("studio", "https://127.0.0.1:9444"),
    id("ale", "https://127.0.0.1:9443", "019f9e"), // a resource token, not an identity
  ];

  it("reads the port out of an auth URL", () => {
    expect(portOfAuthUrl("https://127.0.0.1:9443")).toBe(9443);
    expect(portOfAuthUrl("https://127.0.0.1:9443/019f9e")).toBe(9443);
    expect(portOfAuthUrl("https://example.com")).toBeNull();
  });

  it("answers for one host and never for another", () => {
    expect(identitiesAt(store, "https://127.0.0.1:9443")).toEqual(["u-ale", "u-uitest"]);
    expect(identitiesAt(store, "https://127.0.0.1:9444")).toEqual(["u-studio"]);
  });

  it("does not count a resource token as an identity", () => {
    // It is derived authorization, not a sign-in; counting it would report someone signed in
    // whose identity token had gone.
    expect(identitiesAt(store, "https://127.0.0.1:9443")).not.toContain("u-ale-resource");
    expect(identitiesAt(store, "https://127.0.0.1:9443").filter((x) => x === "u-ale")).toHaveLength(1);
  });

  it("knows nothing about a host with no identity port", () => {
    // A host that needs no sign-in has no store to consult; claiming otherwise would put a
    // warning on a session that never asked for one.
    expect(identitiesAt(store, null)).toEqual([]);
    expect(identitiesAt(store, undefined)).toEqual([]);
  });
});

describe("naming an identity is not the same question as membership", () => {
  // Reported from testing: with a host that has no sign-in selected, every *other* tab showed
  // raw `u-…` ids. The names live in the machine-wide store, and that store was not being read
  // while such a host was active — so the only place the names could come from was missing.
  const store = [
    { auth_url: "https://127.0.0.1:9443", resource: null, user: "ale", user_id: "u-87c4", domains: [], expires_raw: null, expires_ms: null },
    { auth_url: "https://127.0.0.1:9443", resource: null, user: "uitest", user_id: "u-99f5", domains: [], expires_raw: null, expires_ms: null },
  ];

  it("resolves a name from the whole store, whichever host is selected", () => {
    expect(nameForId("u-87c4", store)).toBe("ale (u-87c4)");
    expect(nameForId("u-99f5", store)).toBe("uitest (u-99f5)");
  });

  it("still scopes membership to one host", () => {
    // The split that matters: a name is a label and comes from anywhere; being signed in is
    // per auth URL and must not.
    expect(identitiesAt(store, "https://127.0.0.1:9443")).toEqual(["u-87c4", "u-99f5"]);
    expect(identitiesAt(store, "https://127.0.0.1:9444")).toEqual([]);
  });

  it("falls back to the id rather than showing nothing", () => {
    expect(nameForId("u-unknown", store)).toBe("u-unknown");
  });
});

describe("a lock is not an auth problem", () => {
  // The three failures that look alike already had opposite fixes; this is a fourth that
  // resembles them and has nothing to do with identity at all. Sending someone to sign in
  // over a colleague's open file wastes their time and does not release the lock.
  it("names the lock rather than the account", () => {
    const out = explainError("[Error] File is locked by daniel", "ale");
    expect(out.message).toMatch(/someone else has this file locked/i);
    expect(out.message).not.toMatch(/expired|no access/i);
    expect(out.detail).toContain("locked by daniel");
  });

  it("is checked before the auth cases, because lock messages name people", () => {
    // "locked by ale" contains a username; read as an identity problem it would be reported
    // as a permission failure.
    const out = explainError("Not authorized: file is locked by ale");
    expect(out.message).toMatch(/locked/i);
  });

  it("leaves a genuine permission failure alone", () => {
    const out = explainError("[Error] Not authorized to access repository", "uitest");
    expect(out.message).toMatch(/no access to this repository/i);
  });
});

describe("accountsAt", () => {
  const all = [
    { auth_url: "https://127.0.0.1:9443", user: "ale", user_id: "u-87c4", expires: null, resource: null },
    { auth_url: "https://127.0.0.1:9443", user: "uitest", user_id: "u-99f5", expires: null, resource: null },
    { auth_url: "https://127.0.0.1:9443", user: "ale", user_id: "u-87c4", expires: null, resource: "019f" },
    { auth_url: "https://other.host:9443", user: "dana", user_id: "u-dana", expires: null, resource: null },
  ] as never[];

  it("returns the accounts at that host, named as the user knows them", () => {
    expect(accountsAt(all, "https://127.0.0.1:9443")).toEqual([
      { id: "u-87c4", name: "ale" },
      { id: "u-99f5", name: "uitest" },
    ]);
  });

  it("returns nothing for a host with no auth URL", () => {
    // Reported from testing against the LAN host, which has no identity provider:
    //   $ lore lock query --branch main --owner u-99f5f8484b0a47fd    exit 255
    //   [Error] Failed to resolve user id from user name:
    //           Operation not supported: No authentication configured on server
    // Such a host cannot resolve a user id at all, so nothing should be asked of it.
    expect(accountsAt(all, null)).toEqual([]);
    expect(accountsAt(all, "")).toEqual([]);
    expect(accountsAt(all, undefined)).toEqual([]);
  });

  it("never mixes in another host's accounts", () => {
    // Identities are filed per auth URL. Attributing a lock with a different host's ids asks
    // a server about people it has never heard of — and that is what produced the error
    // above: ctone's user ids sent to a host that has no identities at all.
    expect(accountsAt(all, "https://other.host:9443")).toEqual([{ id: "u-dana", name: "dana" }]);
  });

  it("ignores resource-scoped entries, which are not sign-ins", () => {
    expect(accountsAt(all, "https://127.0.0.1:9443").filter((a) => a.id === "u-87c4")).toHaveLength(1);
  });
});

describe("the untrusted-CA failure is told, not relayed", () => {
  // The signature exactly as ctone produced it live (2026-08-16), when this machine had not
  // yet trusted the host's private CA. Everything visible said "network": the words contain
  // "failed to connect" and "transport error", the tunnel was green, and the raw text reached
  // the screen. The fix is a one-time trust-store import, and the message must say so.
  const live =
    "[Error] Failed to connect to remote grpc://127.0.0.1:41400: failed to connect to auth endpoint: transport error\n" +
    "  at lore-transport/src/auth/exchange.rs:31 - Failed to exchange token\n" +
    "  at lore-transport/src/connection.rs:295 - authorization failure";

  it("recognises the live signature and names the certificate, not the network", () => {
    expect(looksLikeUntrustedCa(live)).toBe(true);
    const { message, detail } = explainError(live);
    expect(message).toMatch(/does not trust the host's identity certificate/i);
    expect(message).toMatch(/CA certificate/);
    expect(detail).toBe(live);
  });

  it("also recognises the debug-log phrasing", () => {
    expect(looksLikeUntrustedCa("Auth exchange failed … failed to connect to auth endpoint")).toBe(true);
  });

  it("does NOT claim a certificate problem for a bare transport error", () => {
    // A host that is genuinely down produces "transport error" without the auth-endpoint
    // anchor. Blaming the certificate there would send someone importing CAs at a dead host.
    expect(looksLikeUntrustedCa("[Error] Disconnected from server: transport error")).toBe(false);
  });
});
