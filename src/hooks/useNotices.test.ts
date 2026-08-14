import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MAX_NOTICES, useNotices } from "./useNotices";

describe("useNotices", () => {
  it("adds newest first", () => {
    const { result } = renderHook(() => useNotices());
    act(() => void result.current.push("info", "first"));
    act(() => void result.current.push("info", "second"));
    expect(result.current.notices.map((n) => n.message)).toEqual(["second", "first"]);
  });

  it("gives every notice a unique id even within the same millisecond", () => {
    // Several events can land together; colliding React keys render the wrong rows.
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.push("info", "a");
      result.current.push("info", "b");
      result.current.push("info", "c");
    });
    const ids = result.current.notices.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps the buffer so a long session cannot grow without bound", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      for (let i = 0; i < MAX_NOTICES + 50; i++) result.current.push("info", `m${i}`);
    });
    expect(result.current.notices).toHaveLength(MAX_NOTICES);
    // The newest survive; the oldest are dropped.
    expect(result.current.notices[0].message).toBe(`m${MAX_NOTICES + 49}`);
  });

  it("keeps level and session name", () => {
    const { result } = renderHook(() => useNotices());
    act(() => void result.current.push("warn", "careful", "Studio main"));
    expect(result.current.notices[0].level).toBe("warn");
    expect(result.current.notices[0].source).toBe("Studio main");
  });

  it("clears", () => {
    const { result } = renderHook(() => useNotices());
    act(() => void result.current.push("info", "x"));
    act(() => result.current.clear());
    expect(result.current.notices).toHaveLength(0);
  });
});
