import { describe, expect, it } from "vitest";
import { BACKOFF_MS, decideReconnect, exhaustedMessage, reconnectMessage } from "./reconnect";

/**
 * A P2P host is a process, and processes die for reasons the user neither caused nor saw —
 * a coordinator restart, a peer going away, a network blink. Until now the host simply
 * stayed down until somebody noticed and pressed Connect.
 */

describe("decideReconnect", () => {
  it("retries a tunnel that died on its own", () => {
    const d = decideReconnect({ intentional: false, attempts: 0, isP2p: true });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(BACKOFF_MS[0]);
  });

  it("never retries a disconnect the user asked for", () => {
    // The worst possible bug in a feature like this: a killed child exits exactly like a
    // crashed one, so without the registry's record of intent, pressing Disconnect would
    // reconnect immediately.
    expect(decideReconnect({ intentional: true, attempts: 0, isP2p: true }).retry).toBe(false);
  });

  it("does nothing for a direct host, which has no process to restart", () => {
    expect(decideReconnect({ intentional: false, attempts: 0, isP2p: false }).retry).toBe(false);
  });

  it("widens the wait between attempts", () => {
    const delays = BACKOFF_MS.map(
      (_, i) => decideReconnect({ intentional: false, attempts: i, isP2p: true }).delayMs,
    );
    expect(delays).toEqual(BACKOFF_MS);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it("gives up rather than hammering a coordinator that is down", () => {
    // Four failures in a row mean a cause retrying cannot fix — a coordinator that is off, a
    // session already paired, a wrong key — and the coordinator is shared infrastructure.
    const d = decideReconnect({ intentional: false, attempts: BACKOFF_MS.length, isP2p: true });
    expect(d.retry).toBe(false);
    expect(d.exhausted).toBe(true);
  });
});

describe("what it says", () => {
  it("counts attempts from one, and names the host", () => {
    const s = reconnectMessage("main", 0, 5000);
    expect(s).toContain("main");
    expect(s).toMatch(/attempt 1 of/);
    expect(s).toMatch(/5s/);
  });

  it("explains the silence when it stops trying", () => {
    // Otherwise the app simply goes quiet, which reads as the feature being broken.
    expect(exhaustedMessage("main")).toMatch(/press connect/i);
  });
});
