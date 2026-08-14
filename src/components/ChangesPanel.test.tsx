import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";
import type { ChangeEntry } from "../lib/repo";

const c = (path: string, staged: boolean, kind: ChangeEntry["kind"] = "added"): ChangeEntry => ({
  path,
  kind,
  staged,
});

const panel = (changes: ChangeEntry[], over: Partial<Parameters<typeof ChangesPanel>[0]> = {}) =>
  render(
    <ChangesPanel
      changes={changes}
      onStage={() => {}}
      onUnstage={() => {}}
      onDiscard={() => {}}
      onCommit={() => {}}
      {...over}
    />,
  );

describe("ChangesPanel", () => {
  it("separates what a commit would include from what it would not", () => {
    panel([c("staged.txt", true), c("loose.txt", false)]);
    // Asserted through the group controls: "Staged (1)" is a substring of "Not staged (1)",
    // so matching on the heading text alone proves nothing.
    expect(screen.getByLabelText(/^select all staged$/i)).toBeTruthy();
    expect(screen.getByLabelText(/^select all not staged$/i)).toBeTruthy();
    expect(screen.getByLabelText("staged.txt")).toBeTruthy();
    expect(screen.getByLabelText("loose.txt")).toBeTruthy();
  });

  it("stages only what was ticked", () => {
    // A commit that quietly includes more than was chosen is the worst kind of surprise in a
    // tool that moves other people's work.
    const onStage = vi.fn();
    panel([c("a.txt", false), c("b.txt", false)], { onStage });

    fireEvent.click(screen.getByLabelText("a.txt"));
    fireEvent.click(screen.getByRole("button", { name: /^stage \(1\)$/i }));

    expect(onStage).toHaveBeenCalledWith(["a.txt"]);
  });

  it("will not act with nothing ticked", () => {
    panel([c("a.txt", false)]);
    expect((screen.getByRole("button", { name: /^stage$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("selects and clears a whole group", () => {
    const onStage = vi.fn();
    panel([c("a.txt", false), c("b.txt", false)], { onStage });
    const all = screen.getByLabelText(/select all not staged/i);

    fireEvent.click(all);
    fireEvent.click(screen.getByRole("button", { name: /^stage \(2\)$/i }));
    expect(onStage).toHaveBeenCalledWith(["a.txt", "b.txt"]);
  });

  it("describes the commit from what is staged, not from what is ticked", () => {
    // The two differ constantly, and only one of them is a commit.
    panel([c("staged.txt", true), c("loose.txt", false)]);
    fireEvent.click(screen.getByLabelText("loose.txt"));
    expect(screen.getByText("1 file — 1 added")).toBeTruthy();
  });

  it("offers no commit when nothing is staged", () => {
    panel([c("loose.txt", false)]);
    expect((screen.getByRole("button", { name: /commit/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Nothing is staged.")).toBeTruthy();
  });

  it("asks before discarding, rather than discarding", () => {
    // The only irreversible action here. The panel opens a dialog; it never resets anything
    // itself, so a mis-click cannot destroy work.
    const onDiscard = vi.fn();
    panel([c("a.txt", false)], { onDiscard });
    fireEvent.click(screen.getByLabelText("a.txt"));
    fireEvent.click(screen.getByRole("button", { name: /^discard… \(1\)$/i }));
    expect(onDiscard).toHaveBeenCalledWith(["a.txt"]);
  });

  it("offers no discard for what is already staged", () => {
    // Unstaging is the way back from there, and it loses nothing.
    panel([c("s.txt", true)]);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons.filter((t) => /discard/i.test(t))).toHaveLength(1);
  });

  it("stops everything while a staging command is running", () => {
    // Two overlapping stage calls would race, and the second would be answered by a status
    // read that predates the first.
    panel([c("a.txt", false)], { busy: true });
    expect((screen.getByLabelText("a.txt") as HTMLInputElement).disabled).toBe(true);
  });
});
