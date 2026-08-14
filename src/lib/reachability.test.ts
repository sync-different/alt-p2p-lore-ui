import { describe, expect, it } from "vitest";
import { explainUnreachable, looksUnreachable, reachability, type Tunnel } from "./reachability";

/**
 * The failure this exists for, reported from testing:
 *
 *   connected as session "daniel" (forwarding 41501), opened a repository cloned through
 *   "main" (remote grpc://127.0.0.1:41400), pressed refresh, and got
 *   "Disconnected from server … Unable to check lock status while offline".
 *
 * Everything about that message points at the network. The tunnel was healthy; it was simply
 * listening on a different port than the working copy dials.
 *
 * And the correction that followed: the question is about the **machine**, not the tab.
 * `lore` dials a loopback port and cannot see which session is on screen, so a repository
 * served by another tab's tunnel is reachable. Asking only about the active tab warned about
 * a setup that worked.
 */

const t = (sessionName: string, port: number, connected = true): Tunnel => ({
  sessionName,
  port,
  connected,
});

describe("reachability", () => {
  it("is satisfied by any live tunnel on the right port, whatever tab is on screen", () => {
    const r = reachability({ remotePort: 41400, tunnels: [t("daniel", 41400)] });
    expect(r.state).toBe("ok");
    expect(r.servedBy).toBe("daniel");
  });

  it("names which session is carrying it, so a later failure has a starting point", () => {
    const r = reachability({
      remotePort: 41400,
      tunnels: [t("main", 41501), t("daniel", 41400)],
    });
    expect(r.state).toBe("ok");
    expect(r.servedBy).toBe("daniel");
  });

  it("ignores a tunnel that is not connected yet", () => {
    // Right port, still punching: nothing is listening, so nothing is reachable.
    const r = reachability({ remotePort: 41400, tunnels: [t("daniel", 41400, false)] });
    expect(r.state).toBe("not_connected");
  });

  it("names both ports when something is connected but not on this one", () => {
    const r = reachability({ remotePort: 41400, tunnels: [t("daniel", 41501)] });
    expect(r.state).toBe("port_mismatch");
    expect(r.message).toContain("41400");
    expect(r.message).toContain("41501");
    expect(r.message).toContain("daniel");
  });

  it("offers both ways out, because only the user knows which is right", () => {
    // Connect a different session, or re-point this one — the second is correct only if the
    // sessions reach the same host, which the app cannot know.
    const r = reachability({ remotePort: 41400, tunnels: [t("daniel", 41501)] });
    expect(r.message).toMatch(/connect the session/i);
    expect(r.message).toMatch(/local port/i);
    // And the part that is easy to forget: a config change does nothing until reconnect.
    expect(r.message).toMatch(/reconnect/i);
  });

  it("says which port is needed when nothing is connected at all", () => {
    const r = reachability({ remotePort: 41400, tunnels: [] });
    expect(r.state).toBe("not_connected");
    expect(r.message).toContain("41400");
  });

  it("says nothing about a repository with no remote", () => {
    // Created locally, never cloned. There is nothing to reach and nothing to warn about.
    const r = reachability({ remotePort: null, tunnels: [t("daniel", 41400)] });
    expect(r.state).toBe("no_remote");
    expect(r.message).toBeUndefined();
  });
});

describe("explainUnreachable", () => {
  const mismatch = reachability({ remotePort: 41400, tunnels: [t("daniel", 41501)] });

  it("replaces the gRPC error with the reason", () => {
    const raw =
      "[Error] Disconnected from server at lore-transport/src/grpc/mod.rs:588 " +
      "connect: grpc://127.0.0.1:41400 - Unable to check lock status while offline";
    expect(explainUnreachable(raw, mismatch)).toBe(mismatch.message);
  });

  it("leaves the error alone when the port is served", () => {
    // A genuinely dropped connection must not be blamed on a port that was always correct.
    const ok = reachability({ remotePort: 41400, tunnels: [t("daniel", 41400)] });
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
