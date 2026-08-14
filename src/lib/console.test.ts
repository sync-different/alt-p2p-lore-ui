import { describe, expect, it } from "vitest";
import {
  formatMs,
  mergeFeed,
  problemCount,
  traceColour,
  tunnelColour,
  type TraceLine,
  type TunnelLine,
} from "./console";
import { normalise, DEFAULTS } from "./settings";
import type { Notice, NoticeLevel } from "../types/app";

const notice = (id: string, level: NoticeLevel, at: number, message = "m"): Notice => ({
  id,
  level,
  at,
  message,
});

const trace = (id: string, at: number, ok = true, command = "status --scan"): TraceLine => ({
  id,
  at,
  command,
  cwd: "/repo",
  ms: 120,
  code: ok ? 0 : 1,
  ok,
  error: ok ? null : "Disconnected from server",
});

const tun = (
  id: string,
  at: number,
  level: TunnelLine["level"] = "info",
  line = "Punching to 1.2.3.4:41234",
): TunnelLine => ({ id, at, session_name: "main", stream: "err", level, line });

describe("tunnel output", () => {
  const notices = [notice("n1", "error", 100)];

  it("is hidden until debug is on, like the command trace", () => {
    expect(mergeFeed(notices, [], "all", false, 500, [tun("o1", 200)]).map((l) => l.id)).toEqual([
      "n1",
    ]);
  });

  it("appears interleaved with everything else once debug is on", () => {
    const feed = mergeFeed(notices, [], "all", true, 500, [tun("o1", 200)]);
    expect(feed.map((l) => l.id)).toEqual(["o1", "n1"]);
  });

  it("shows an ERROR line from the tunnel under Problems", () => {
    // The case this exists for: "The connection to the host ended" with no cause. Whatever
    // the jar said on its way out is exactly what someone filtering for problems wants.
    const feed = mergeFeed([], [], "problems", true, 500, [
      tun("o1", 1, "info"),
      tun("o2", 2, "error", "ERROR Session full"),
    ]);
    expect(feed.map((l) => l.id)).toEqual(["o2"]);
  });

  it("does not treat an ordinary stderr line as a failure", () => {
    // Java logs progress to stderr. Colouring the stream rather than the level would paint a
    // healthy connection red from end to end.
    expect(tunnelColour(tun("o", 1, "info"))).not.toContain("danger");
    expect(tunnelColour(tun("o", 1, "error"))).toContain("danger");
    expect(tunnelColour(tun("o", 1, "warn"))).toContain("warn");
  });

  it("counts tunnel errors in the Problems badge", () => {
    expect(problemCount([], [], true, [tun("o1", 1, "error")])).toBe(1);
    expect(problemCount([], [], false, [tun("o1", 1, "error")])).toBe(0);
  });
});

describe("mergeFeed", () => {
  const notices = [notice("n1", "info", 200), notice("n2", "error", 100)];
  const traces = [trace("t1", 150), trace("t2", 50, false)];

  it("interleaves both streams by time, newest first", () => {
    const feed = mergeFeed(notices, traces, "all", true);
    expect(feed.map((l) => l.id)).toEqual(["n1", "t1", "n2", "t2"]);
  });

  it("hides commands entirely while debug is off", () => {
    // The default for an artist: a developer's view of somebody else's tool is noise.
    const feed = mergeFeed(notices, traces, "all", false);
    expect(feed.map((l) => l.id)).toEqual(["n1", "n2"]);
  });

  it("shows a failed command under Problems, and no successful one", () => {
    // A command that failed *is* a problem, and is exactly what someone filtering for
    // problems is hunting. A successful one is not, however interesting.
    const feed = mergeFeed(notices, traces, "problems", true);
    expect(feed.map((l) => l.id)).toEqual(["n2", "t2"]);
  });

  it("keeps Problems to warnings and errors when debug is off", () => {
    const feed = mergeFeed(notices, traces, "problems", false);
    expect(feed.map((l) => l.id)).toEqual(["n2"]);
  });

  it("shows only commands on the Debug tab", () => {
    const feed = mergeFeed(notices, traces, "debug", true);
    expect(feed.map((l) => l.id)).toEqual(["t1", "t2"]);
  });

  it("caps the feed, because tunnels emit all day", () => {
    const many = Array.from({ length: 900 }, (_, i) => notice(`n${i}`, "info", i));
    expect(mergeFeed(many, [], "all", false).length).toBe(500);
  });

  it("keeps the newest when it caps, not the oldest", () => {
    // Slicing before sorting would silently keep the wrong end of the day.
    const many = Array.from({ length: 900 }, (_, i) => notice(`n${i}`, "info", i));
    const feed = mergeFeed(many, [], "all", false);
    expect(feed[0].at).toBe(899);
  });
});

describe("problemCount", () => {
  it("counts failed commands alongside warnings and errors", () => {
    const n = [notice("n1", "warn", 1), notice("n2", "error", 2), notice("n3", "info", 3)];
    expect(problemCount(n, [trace("t1", 4, false)], true)).toBe(3);
  });

  it("ignores commands while debug is off, since none are shown", () => {
    // A badge counting lines the user cannot see is a badge they cannot clear.
    expect(problemCount([notice("n1", "warn", 1)], [trace("t1", 2, false)], false)).toBe(1);
  });
});

describe("traceColour", () => {
  it("marks a failed command in red among the dim ones", () => {
    expect(traceColour(trace("t", 1, false))).toContain("danger");
    expect(traceColour(trace("t", 1, true))).not.toContain("danger");
  });
});

describe("formatMs", () => {
  it("reads at a glance rather than precisely", () => {
    expect(formatMs(214)).toBe("214ms");
    expect(formatMs(1430)).toBe("1.4s");
  });
});

describe("settings", () => {
  it("defaults debug off", () => {
    expect(DEFAULTS.debug).toBe(false);
  });

  it("rejects a non-boolean rather than trusting it", () => {
    // `{"debug": "false"}` is truthy in JavaScript: a hand-edited file saying off would
    // switch it on.
    expect(normalise({ debug: "false" }).debug).toBe(false);
    expect(normalise({ debug: 1 }).debug).toBe(false);
  });

  it("survives junk", () => {
    expect(normalise(null)).toEqual(DEFAULTS);
    expect(normalise("nonsense")).toEqual(DEFAULTS);
  });

  it("keeps a valid value", () => {
    expect(normalise({ debug: true }).debug).toBe(true);
  });
});
