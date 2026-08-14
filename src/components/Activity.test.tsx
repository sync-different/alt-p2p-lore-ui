import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Activity } from "./Activity";
import type { Notice } from "../types/app";

/**
 * The feed's job when several sessions are open at once.
 *
 * Reported from testing: "the activity problems doesn't show what tab/session the messages
 * correspond to". With one tunnel that is a cosmetic gap; with three it makes the feed
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

describe("Activity", () => {
  it("names the session a line is about", () => {
    render(<Activity notices={[notice({ source: "Studio main" })]} />);
    expect(screen.getByText(/Studio main/)).toBeTruthy();
  });

  it("distinguishes two sessions reporting the same thing", () => {
    // The case that makes an unlabelled feed dangerous: identical text, different tunnels.
    render(
      <Activity
        notices={[
          notice({ message: "Connected", source: "Daniel", level: "success" }),
          notice({ message: "Connected", source: "Win", level: "success" }),
        ]}
       
      />,
    );
    expect(screen.getByText(/Daniel/)).toBeTruthy();
    expect(screen.getByText(/Win/)).toBeTruthy();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
  });

  it("labels repository work with its workspace, not with a host", () => {
    // Reported from testing: "the activity tab only shows the time, so the user doesn't know
    // what tab the message is from." Tabs are workspaces now, and repository events — the
    // majority — were arriving with no label at all.
    render(
      <Activity
        notices={[
          notice({ message: "Could not check locks", level: "warn", source: "demo as ale" }),
          notice({ message: "Connected", level: "success", source: "main" }),
        ]}
      />,
    );
    expect(screen.getByText(/demo as ale/)).toBeTruthy();
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  it("still renders a line that belongs to no session", () => {
    // App-level notices (prerequisites, saving a config) have no tunnel behind them.
    render(<Activity notices={[notice({ message: "All prerequisites ready" })]} />);
    expect(screen.getByText("All prerequisites ready")).toBeTruthy();
  });
});
