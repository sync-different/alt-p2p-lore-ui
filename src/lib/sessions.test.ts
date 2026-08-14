import { describe, expect, it } from "vitest";
import { authorityOf, hostAuthUrl, hostBaseUrl, hostServes, type SessionConfig } from "./sessions";

/**
 * A host is identified by the URL its working copies dial. P2P derives that from the port the
 * tunnel forwards; a direct host is given it. Everything downstream — reachability, the token
 * store, cloning — then speaks one language, and the tunnel becomes a transport detail rather
 * than the organising principle.
 */

const p2p = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  id: "h1",
  name: "ctone",
  session_id: "lore-x",
  server: "coord.example.com:9000",
  loreserver_port: 41400,
  identity_port: 9443,
  allow_relay: true,
  ...over,
});

const direct = (over: Partial<SessionConfig> = {}): SessionConfig =>
  p2p({ kind: "direct", base_url: "grpc://lore.example:41337", auth_url: null, ...over });

describe("host identity", () => {
  it("derives a P2P host's URLs from its ports", () => {
    expect(hostBaseUrl(p2p())).toBe("grpc://127.0.0.1:41400");
    expect(hostAuthUrl(p2p())).toBe("https://127.0.0.1:9443");
  });

  it("treats a config with no kind as P2P", () => {
    // Written before direct hosts existed. It must keep working untouched.
    const legacy = { ...p2p() };
    delete (legacy as { kind?: unknown }).kind;
    expect(hostBaseUrl(legacy)).toBe("grpc://127.0.0.1:41400");
  });

  it("uses a direct host's own URLs", () => {
    expect(hostBaseUrl(direct())).toBe("grpc://lore.example:41337");
    expect(hostAuthUrl(direct({ auth_url: "https://id.example:9443" }))).toBe("https://id.example:9443");
  });

  it("needs no sign-in when a host has no auth URL", () => {
    // A blank string is not an auth URL — filing tokens under "" would be worse than none.
    expect(hostAuthUrl(direct({ auth_url: null }))).toBeNull();
    expect(hostAuthUrl(direct({ auth_url: "  " }))).toBeNull();
    expect(hostAuthUrl(p2p({ identity_port: null }))).toBeNull();
  });
});

describe("which host serves a working copy", () => {
  it("matches on authority, not on the whole string", () => {
    // The two URLs are written by different programs; paths and trailing slashes differ.
    expect(hostServes(p2p(), "grpc://127.0.0.1:41400")).toBe(true);
    expect(hostServes(p2p(), "grpc://127.0.0.1:41400/019f9e")).toBe(true);
    expect(hostServes(direct(), "grpc://lore.example:41337/atlas")).toBe(true);
  });

  it("does not match a different port on the same machine", () => {
    // Two P2P hosts can be configured on different local ports; only the right one serves.
    expect(hostServes(p2p(), "grpc://127.0.0.1:41600")).toBe(false);
  });

  it("does not confuse a direct host with a loopback one", () => {
    // The bug this replaces: matching by port alone made every host on 41337 the same host.
    expect(hostServes(direct({ base_url: "grpc://lore.example:41400" }), "grpc://127.0.0.1:41400")).toBe(false);
  });

  it("says nothing about a working copy with no remote", () => {
    expect(hostServes(p2p(), null)).toBe(false);
    expect(authorityOf(null)).toBeNull();
    expect(authorityOf("")).toBeNull();
  });
});
