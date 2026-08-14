import { describe, expect, it } from "vitest";
import { phaseToStatus } from "./useTunnels";

/**
 * The mapping from tunnel phase to the colour vocabulary. Small, but it decides what an
 * artist sees on a tab — and getting "connected" wrong in either direction is the failure
 * that matters: green while broken, or red while working.
 */
describe("phaseToStatus", () => {
  it("is green only when actually connected", () => {
    expect(phaseToStatus("connected")).toBe("connected");
  });

  it("distinguishes a relayed connection, which works but is slower", () => {
    expect(phaseToStatus("connected", "relay")).toBe("relay");
    expect(phaseToStatus("connected", "direct")).toBe("connected");
  });

  it("treats every in-flight phase as connecting, not connected", () => {
    // A tab turning green before the tunnel can carry traffic is worse than one turning
    // green late.
    for (const p of ["registering", "waiting_peer", "punching", "handshaking", "relay_tcp", "relaying"] as const) {
      expect(phaseToStatus(p)).toBe("connecting");
    }
  });

  it("maps failure to error", () => {
    expect(phaseToStatus("error")).toBe("error");
  });

  it("treats an unrecognised phase as in-flight, never as connected", () => {
    // alt-p2p ships separately; a new phase must not be mistaken for success.
    expect(phaseToStatus("other")).toBe("connecting");
  });

  it("is disconnected when there is no tunnel at all", () => {
    expect(phaseToStatus(undefined)).toBe("disconnected");
  });

  it("treats a session the user closed as idle, not broken", () => {
    // Reported from testing: "clicked disconnect, left main in red." A killed child exits
    // non-zero exactly like a crashed one, so the process cannot tell them apart — the
    // registry records that the stop was asked for, and this is the phase that carries it.
    expect(phaseToStatus("stopped")).toBe("disconnected");
    expect(phaseToStatus("stopped")).not.toBe("error");
  });
});
