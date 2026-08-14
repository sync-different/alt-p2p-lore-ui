import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTunnels, type TunnelUpdate } from "./useTunnels";

/**
 * The event subscription itself, rather than the mapping it feeds.
 *
 * Reported from testing: "I connected to main, it shows green, but activity says connecting
 * in grey." Both halves were true at once — the registry was re-read (so the tab knew), but
 * the `connected` event never reached the feed. `listen()` is asynchronous, so an effect
 * that re-runs leaves a gap with no listener attached, and the callback was in the effect's
 * dependency list while the caller passed a fresh arrow on every render.
 *
 * These tests are about *not losing events*, which is why they re-render aggressively.
 */

const handlers: Array<(e: { payload: TunnelUpdate }) => void> = [];
const unlisten = vi.fn();
let listenCalls = 0;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: TunnelUpdate }) => void) => {
    listenCalls++;
    handlers.push(handler);
    return Promise.resolve(unlisten);
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve([]),
}));

const update = (over: Partial<TunnelUpdate> = {}): TunnelUpdate => ({
  kind: "ready",
  id: "t1",
  session_id: "lore-main",
  session_name: "Main",
  phase: "connected",
  detail: "Connected",
  mode: "direct",
  url: "grpc://127.0.0.1:41400",
  error: null,
  ...over,
});

/** A component that re-renders on demand and always passes a *new* callback identity. */
function Harness({ onEvent, tick }: { onEvent: (...a: unknown[]) => void; tick: number }) {
  useTunnels((level, message, session) => onEvent(level, message, session, tick));
  return <div data-testid="tick">{tick}</div>;
}

beforeEach(() => {
  handlers.length = 0;
  listenCalls = 0;
  unlisten.mockClear();
});

describe("useTunnels event subscription", () => {
  it("subscribes once, however often the caller re-renders", async () => {
    const onEvent = vi.fn();
    const { rerender } = render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(listenCalls).toBe(1));

    for (let i = 1; i <= 5; i++) rerender(<Harness onEvent={onEvent} tick={i} />);

    // The failure this pins: one subscribe per render, each with a gap in between where
    // events fall on the floor.
    expect(listenCalls).toBe(1);
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("still reports a connection that arrives after many re-renders", async () => {
    const onEvent = vi.fn();
    const { rerender } = render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    for (let i = 1; i <= 10; i++) rerender(<Harness onEvent={onEvent} tick={i} />);
    act(() => handlers[0]({ payload: update() }));

    expect(onEvent).toHaveBeenCalledWith("success", "Connected", "Main", expect.anything());
  });

  it("uses the latest callback, not the one captured when it subscribed", async () => {
    // The cost of holding the callback by reference would be calling a stale one. It isn't.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onEvent={first} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    rerender(<Harness onEvent={second} tick={1} />);
    act(() => handlers[0]({ payload: update() }));

    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it("labels a relayed connection as a warning, and a failure as an error", async () => {
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    act(() => handlers[0]({ payload: update({ mode: "relay", detail: "Connected via relay" }) }));
    expect(onEvent).toHaveBeenCalledWith("warn", "Connected via relay", "Main", expect.anything());

    act(() =>
      handlers[0]({
        payload: update({ kind: "failed", phase: "error", detail: "It failed", error: "boom" }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("error", "It failed", "Main", expect.anything());
  });

  it("reports an event for a tunnel it has not yet loaded", async () => {
    // The exact race behind the report: `start` and the first events land before the
    // registry read returns. Silence here is what left the feed stuck on "Connecting…".
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    act(() => handlers[0]({ payload: update({ id: "never-seen" }) }));
    expect(onEvent).toHaveBeenCalledWith("success", "Connected", "Main", expect.anything());
  });
});

describe("what gets announced", () => {
  it("announces a connection once, not once per event that mentions it", async () => {
    // Reported from testing: "It showed connected in activity twice." Two events carry the
    // connected phase — the peer link coming up, and the local port being ready.
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    act(() => handlers[0]({ payload: update({ kind: "status", detail: "Connected" }) }));
    act(() => handlers[0]({ payload: update({ kind: "ready", detail: "Connected" }) }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("success", "Connected", "Main", expect.anything());
  });

  it("keeps progress out of the feed entirely", async () => {
    // The tab colour is the right place for "punching" and "waiting for peer". A line per
    // phase would bury the events that matter.
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    for (const phase of ["registering", "waiting_peer", "punching", "handshaking"] as const) {
      act(() => handlers[0]({ payload: update({ kind: "status", phase, detail: phase }) }));
    }
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("ending a session on purpose", () => {
  it("is information, not an error", async () => {
    // Reported from testing: disconnect left the tab red with "the connection program
    // stopped" in the feed. The user did that on purpose; nothing went wrong.
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    act(() =>
      handlers[0]({
        payload: update({ kind: "exited", phase: "stopped", detail: "Disconnected.", error: null }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("info", "Disconnected.", "Main", expect.anything());
  });

  it("still reports an exit nobody asked for as an error", async () => {
    // The other half: a crash must not be quietly downgraded to a status line.
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} tick={0} />);
    await waitFor(() => expect(handlers.length).toBe(1));

    act(() =>
      handlers[0]({
        payload: update({
          kind: "exited",
          phase: "error",
          detail: "It stopped unexpectedly (exit code 1).",
          error: "boom",
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      "error",
      "It stopped unexpectedly (exit code 1).",
      "Main",
      expect.anything(),
    );
  });
});
