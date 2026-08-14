import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * That an exit actually *reaches* the caller.
 *
 * Reported from testing: a tunnel was killed from outside the app, the tab went red, and
 * nothing reconnected. The reconnect policy was written and tested; the line that calls it
 * had silently failed to be inserted, so the decision function was never reached. Every test
 * still passed, because they all tested the policy in isolation.
 *
 * This one exercises the wiring instead: dispatch a real event shape and assert the callback
 * fires with the identity and the intent.
 */

type Handler = (e: { payload: Record<string, unknown> }) => void;
let handler: Handler | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, h: Handler) => {
    handler = h;
    return Promise.resolve(() => {});
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

import { useTunnels } from "./useTunnels";

const emit = (over: Record<string, unknown>) =>
  handler?.({
    payload: {
      id: "t1",
      session_id: "lore-test1c-8@rc1!f%3j4",
      session_name: "session_main",
      phase: "error",
      kind: "exited",
      detail: "The connection to the host ended.",
      ...over,
    },
  });

describe("tunnel exits reach the caller", () => {
  it("reports a crash with the session it belongs to", async () => {
    const onExit = vi.fn();
    renderHook(() => useTunnels(undefined, onExit));
    await waitFor(() => expect(handler).not.toBeNull());

    emit({});

    await waitFor(() =>
      expect(onExit).toHaveBeenCalledWith({
        sessionId: "lore-test1c-8@rc1!f%3j4",
        sessionName: "session_main",
        intentional: false,
      }),
    );
  });

  it("marks a disconnect the user asked for as intentional", async () => {
    // A killed child exits exactly like a crashed one, so this flag is the registry's record
    // of intent. Without it, pressing Disconnect would immediately reconnect.
    const onExit = vi.fn();
    renderHook(() => useTunnels(undefined, onExit));
    await waitFor(() => expect(handler).not.toBeNull());

    emit({ phase: "stopped", detail: "Disconnected." });

    await waitFor(() =>
      expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ intentional: true })),
    );
  });

  it("says nothing for events that are not an exit", async () => {
    const onExit = vi.fn();
    renderHook(() => useTunnels(undefined, onExit));
    await waitFor(() => expect(handler).not.toBeNull());

    emit({ kind: "status", phase: "punching" });
    emit({ kind: "ready", phase: "connected" });

    await new Promise((r) => setTimeout(r, 10));
    expect(onExit).not.toHaveBeenCalled();
  });
});
