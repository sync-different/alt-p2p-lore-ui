import { describe, expect, it } from "vitest";
import { TONE_DOT, TONE_TEXT, noticeTone, sessionTone } from "./status";
import type { NoticeLevel, SessionStatus } from "../types/app";

describe("the colour convention", () => {
  it("maps session states to the four tones", () => {
    expect(sessionTone("connected")).toBe("ok");
    expect(sessionTone("disconnected")).toBe("neutral");
    expect(sessionTone("connecting")).toBe("caution");
    expect(sessionTone("error")).toBe("bad");
  });

  it("treats relay as caution, not a colour of its own", () => {
    // It works but is degraded. A fourth colour would be a fourth thing to learn.
    expect(sessionTone("relay")).toBe("caution");
  });

  it("maps notice levels to the same four tones", () => {
    expect(noticeTone("success")).toBe("ok");
    expect(noticeTone("info")).toBe("neutral");
    expect(noticeTone("warn")).toBe("caution");
    expect(noticeTone("error")).toBe("bad");
  });

  it("gives a session and a notice of the same meaning the same colour", () => {
    // The point of sharing the map: "working" must look identical wherever it is reported.
    expect(TONE_DOT[sessionTone("connected")]).toBe(TONE_DOT[noticeTone("success")]);
    expect(TONE_DOT[sessionTone("error")]).toBe(TONE_DOT[noticeTone("error")]);
    expect(TONE_DOT[sessionTone("relay")]).toBe(TONE_DOT[noticeTone("warn")]);
    expect(TONE_DOT[sessionTone("disconnected")]).toBe(TONE_DOT[noticeTone("info")]);
  });

  it("has a colour for every state and level, with no gaps", () => {
    const states: SessionStatus[] = ["connected", "disconnected", "connecting", "relay", "error"];
    const levels: NoticeLevel[] = ["success", "info", "warn", "error"];
    for (const s of states) {
      expect(TONE_DOT[sessionTone(s)]).toBeTruthy();
      expect(TONE_TEXT[sessionTone(s)]).toBeTruthy();
    }
    for (const l of levels) {
      expect(TONE_DOT[noticeTone(l)]).toBeTruthy();
    }
  });
});
