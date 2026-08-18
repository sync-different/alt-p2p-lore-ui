import { describe, expect, it } from "vitest";
import { explainUnreachable, looksUnreachable, reachability, type ServingHost } from "./reachability";

/**
 * The failure this exists for, reported from testing:
 *
 *   connected as "daniel" (forwarding 41501), opened a repository cloned through "main"
 *   (remote grpc://127.0.0.1:41400), pressed refresh, and got "Disconnected from server".
 *
 * Everything about that message points at the network. The tunnel was healthy; it was simply
 * serving a different address than the working copy dials.
 *
 * A host is identified by the URL its working copies dial — derived from a forwarded port for
 * P2P, given outright for a direct host. Matching on the port alone made every host on 41337
 * the same host, which is only true while the transport is a tunnel.
 */

const host = (name: string, baseUrl: string, available = true, isP2p = true): ServingHost => ({
  name,
  baseUrl,
  available,
  isP2p,
});

const CTONE = "grpc://127.0.0.1:41400";
const LOCAL_B = "grpc://127.0.0.1:41600";
const REMOTE = "grpc://lore.example:41337";

describe("reachability", () => {
  it("is satisfied by any available host on the right URL, whatever tab is on screen", () => {
    const r = reachability({ remoteUrl: CTONE, hosts: [host("ctone", CTONE)] });
    expect(r.state).toBe("ok");
    expect(r.servedBy).toBe("ctone");
  });

  it("matches on authority, so a path or trailing slash cannot defeat it", () => {
    // The two URLs are written by different programs.
    const r = reachability({ remoteUrl: `${CTONE}/019f9e`, hosts: [host("ctone", CTONE)] });
    expect(r.state).toBe("ok");
  });

  it("serves a direct host exactly as it serves a tunnelled one", () => {
    // The point of the refactor: past identity, transport does not matter.
    const r = reachability({ remoteUrl: REMOTE, hosts: [host("studio", REMOTE, true, false)] });
    expect(r.state).toBe("ok");
  });

  it("tells a P2P host that is not connected from a direct host that did not answer", () => {
    // Different remedies, so different sentences: one is a button, the other is someone
    // else's machine being down.
    const p2p = reachability({ remoteUrl: CTONE, hosts: [host("ctone", CTONE, false)] });
    expect(p2p.message).toMatch(/not connected/i);

    const direct = reachability({ remoteUrl: REMOTE, hosts: [host("studio", REMOTE, false, false)] });
    expect(direct.message).toMatch(/did not answer/i);
    expect(direct.message).toMatch(/lore\.example:41337/);
  });

  it("names both sides when the hosts that are up serve something else", () => {
    const r = reachability({ remoteUrl: CTONE, hosts: [host("local B", LOCAL_B)] });
    expect(r.state).toBe("port_mismatch");
    expect(r.message).toContain("127.0.0.1:41400");
    expect(r.message).toContain("127.0.0.1:41600");
  });

  it("says so plainly when nothing here serves that address at all", () => {
    const r = reachability({ remoteUrl: REMOTE, hosts: [] });
    expect(r.state).toBe("not_connected");
    expect(r.message).toMatch(/no host here serves it/i);
  });

  it("does not confuse a direct host with a loopback one on the same port", () => {
    // The bug the port-based version had: 41400 anywhere meant 41400 everywhere.
    const r = reachability({
      remoteUrl: CTONE,
      hosts: [host("elsewhere", "grpc://lore.example:41400", true, false)],
    });
    expect(r.state).not.toBe("ok");
  });

  it("says nothing about a repository with no remote", () => {
    const r = reachability({ remoteUrl: null, hosts: [host("ctone", CTONE)] });
    expect(r.state).toBe("no_remote");
    expect(r.message).toBeUndefined();
  });
});

describe("explainUnreachable", () => {
  const mismatch = reachability({ remoteUrl: CTONE, hosts: [host("local B", LOCAL_B)] });

  it("replaces the gRPC error with the reason", () => {
    const raw =
      "[Error] Disconnected from server … connect: grpc://127.0.0.1:41400 - " +
      "Unable to check lock status while offline";
    expect(explainUnreachable(raw, mismatch)).toBe(mismatch.message);
  });

  it("leaves the error alone when the address is served", () => {
    // A genuinely dropped connection must not be blamed on an address that was correct.
    const ok = reachability({ remoteUrl: CTONE, hosts: [host("ctone", CTONE)] });
    const raw = "[Error] Disconnected from server";
    expect(explainUnreachable(raw, ok)).toBe(raw);
  });

  it("leaves unrelated failures alone even when there is a mismatch", () => {
    const raw = "the repository is locked by someone else";
    expect(explainUnreachable(raw, mismatch)).toBe(raw);
  });

  it("recognises the wordings lore actually produces", () => {
    for (const s of [
      "Disconnected from server",
      "Unable to check lock status while offline",
      "connection refused",
      "transport error",
    ]) {
      expect(looksUnreachable(s)).toBe(true);
    }
    expect(looksUnreachable("Not found")).toBe(false);
  });
});

describe("an untrusted-CA failure is not 'unreachable'", () => {
  it("keeps the CA signature out of the unreachable bucket, so retry-on-return never arms", () => {
    const ca =
      "[Error] Failed to connect to remote grpc://127.0.0.1:41400: failed to connect to auth endpoint: transport error";
    expect(looksUnreachable(ca)).toBe(false);
    // …while a bare transport error stays what it always was.
    expect(looksUnreachable("[Error] Disconnected from server: transport error")).toBe(true);
  });
});
