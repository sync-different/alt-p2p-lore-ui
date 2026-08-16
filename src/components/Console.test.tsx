import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Console } from "./Console";
import type { Notice } from "../types/app";
import type { TraceLine } from "../lib/console";

/**
 * The console's job when several sessions are open at once, plus the debug stream.
 *
 * The labelling cases came from the Activity pane this replaces, and they are the reason it
 * labels at all. Reported from testing: "the activity problems doesn't show what tab/session
 * the messages correspond to". With one tunnel that is cosmetic; with three it makes the feed
 * actively misleading, because "Connected" and "The connection failed" read as being about
 * whichever tab you happen to be looking at.
 */

let n = 0;
function notice(over: Partial<Notice> = {}): Notice {
  return {
    id: `n${++n}`,
    level: "info",
    at: 1_760_000_000_000,
    message: "Connected",
    ...over,
  };
}

function trace(over: Partial<TraceLine> = {}): TraceLine {
  return {
    id: `t${++n}`,
    at: 1_760_000_000_000,
    command: "status --scan",
    cwd: "/repo",
    ms: 214,
    code: 0,
    ok: true,
    error: null,
    ...over,
  };
}

const view = (props: Partial<Parameters<typeof Console>[0]> = {}) =>
  render(
    <Console
      notices={[]}
      traces={[]}
      debugEnabled={false}
      onClear={vi.fn()}
      onOpenSettings={vi.fn()}
      {...props}
    />,
  );

describe("Console", () => {
  it("names the session a line is about", () => {
    view({ notices: [notice({ source: "Studio main" })] });
    expect(screen.getByText(/Studio main/)).toBeTruthy();
  });

  it("distinguishes two sessions reporting the same thing", () => {
    // The case that makes an unlabelled feed dangerous: identical text, different tunnels.
    view({
      notices: [
        notice({ message: "Connected", source: "Daniel", level: "success" }),
        notice({ message: "Connected", source: "Win", level: "success" }),
      ],
    });
    expect(screen.getByText(/Daniel/)).toBeTruthy();
    expect(screen.getByText(/Win/)).toBeTruthy();
    expect(screen.getAllByText(/Connected/)).toHaveLength(2);
  });

  it("labels repository work with its workspace, not with a host", () => {
    view({
      notices: [
        notice({ message: "Could not check locks", level: "warn", source: "demo as ale" }),
        notice({ message: "Connected", level: "success", source: "main" }),
      ],
    });
    expect(screen.getByText(/demo as ale/)).toBeTruthy();
  });

  it("still renders a line that belongs to no session", () => {
    // App-level notices (prerequisites, saving a config) have no tunnel behind them.
    view({ notices: [notice({ message: "All prerequisites ready" })] });
    expect(screen.getByText(/All prerequisites ready/)).toBeTruthy();
  });

  it("shows no commands until debug is switched on", () => {
    view({ traces: [trace()] });
    expect(screen.queryByText(/status --scan/)).toBeNull();
  });

  it("shows the command, its duration and its exit code with debug on", () => {
    view({ traces: [trace()], debugEnabled: true });
    expect(screen.getByText(/lore status --scan/)).toBeTruthy();
    expect(screen.getByText(/214ms/)).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
  });

  it("shows why a command failed, not merely that it did", () => {
    view({
      traces: [trace({ ok: false, code: 1, error: "Disconnected from server" })],
      debugEnabled: true,
    });
    expect(screen.getByText(/Disconnected from server/)).toBeTruthy();
  });

  it("displays the redacted command it was given, and never a secret", () => {
    // Redaction happens in Rust, at the point of formatting — this asserts the component does
    // not somehow reconstruct or reveal anything, and documents that the contract is upstream.
    view({ traces: [trace({ command: "auth login --token-type lore --token ***" })], debugEnabled: true });
    expect(screen.getByText(/--token \*\*\*/)).toBeTruthy();
  });

  it("offers Settings instead of an empty Debug tab when debug is off", () => {
    // Otherwise the only way to find the switch is to already know where it lives.
    const onOpenSettings = vi.fn();
    view({ onOpenSettings });
    screen.getByTitle(/enable in Settings/i).click();
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

describe("which build you are running", () => {
  it("shows the version and build number", () => {
    // The question this answers is not "what version is this" but "is the thing I am running
    // the thing you just gave me?" — which came up on every hand-off during testing, and was
    // only answerable by comparing binary timestamps.
    view({});
    expect(screen.getByText(/v0\.0\.0-test/)).toBeTruthy();
    expect(screen.getByText(/b0/)).toBeTruthy();
  });

  it("spells it out in full on hover", () => {
    view({});
    expect(screen.getByTitle(/alt-lore Desktop 0\.0\.0-test · build 0/)).toBeTruthy();
  });
});
