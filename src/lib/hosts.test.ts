import { describe, expect, it } from "vitest";
import { cameBack, isServing, probeLabel, probeStatus } from "./hosts";

/**
 * Found with a real host switched off: the bar showed it green.
 *
 * A direct host had no probe, so the dot was hardcoded to "connected" — the app claiming a
 * state it had never checked. Green is what lets somebody start a long push, and this project
 * has one rule above the rest: a state the app cannot vouch for is never shown as fine.
 */

describe("probeStatus", () => {
  it("is green only when something actually answered", () => {
    expect(probeStatus("up")).toBe("connected");
  });

  it("is not green for a host that refused or never answered", () => {
    // The two real failures of one afternoon: a stopped loreserver (refused in 0.2s) and a
    // machine that went to sleep (no answer at all).
    for (const p of ["refused", "unreachable", "bad"] as const) {
      expect(probeStatus(p)).not.toBe("connected");
      expect(probeStatus(p)).toBe("error");
    }
  });

  it("says checking before the first answer, not fine", () => {
    // The window has just opened and nothing is known. Showing green here is the same
    // unjustified claim, only briefer.
    expect(probeStatus(undefined)).toBe("connecting");
    expect(probeStatus(undefined)).not.toBe("connected");
  });
});

describe("probeLabel", () => {
  it("tells nothing-listening apart from nothing-answering", () => {
    // They send you to different places: start the service, or go and look at the machine.
    const refused = probeLabel("refused", "fedora", "grpc://192.168.1.20:41337");
    expect(refused).toMatch(/not running|nothing is listening/i);

    const gone = probeLabel("unreachable", "fedora", "grpc://192.168.1.20:41337");
    expect(gone).toMatch(/asleep|off|unreachable/i);
    expect(gone).not.toMatch(/not running/i);
  });

  it("names the host and the address in every state", () => {
    for (const p of ["up", "refused", "unreachable", "bad", undefined] as const) {
      const s = probeLabel(p, "fedora", "grpc://192.168.1.20:41337");
      expect(s).toContain("fedora");
      expect(s).toContain("192.168.1.20:41337");
    }
  });

  it("blames the settings, not the network, for an address it cannot parse", () => {
    expect(probeLabel("bad", "typo", "grpc://192.168.1.20")).toMatch(/host settings/i);
  });
});

describe("isServing", () => {
  it("is true only for a host that answered", () => {
    expect(isServing("up")).toBe(true);
    for (const p of ["refused", "unreachable", "bad", undefined] as const) {
      expect(isServing(p)).toBe(false);
    }
  });
});

describe("cameBack", () => {
  it("fires when a host that was down starts answering", () => {
    // The case: loreserver stopped, the dot went red, the service was started again.
    expect(cameBack("refused", "up")).toBe(true);
    expect(cameBack("unreachable", "up")).toBe(true);
  });

  it("does not fire on the first answer after launch", () => {
    // Nothing "came back" — the app has only just started asking. Announcing here would be a
    // notification about nothing, and re-reading would duplicate what opening already did.
    expect(cameBack(undefined, "up")).toBe(false);
  });

  it("does not fire while a host simply stays up", () => {
    // The probe runs every 15s; this must not re-read the repository four times a minute.
    expect(cameBack("up", "up")).toBe(false);
  });

  it("does not fire on the way down, or into an unknown state", () => {
    expect(cameBack("up", "refused")).toBe(false);
    expect(cameBack("refused", undefined)).toBe(false);
  });
});
