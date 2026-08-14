import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * `invoke` and the diff command are mocked, so these test the component's decisions rather
 * than Tauri: what it shows for each kind of file, and — the case that matters most — how
 * it presents a file Lore calls changed that has no actual differences.
 */

const mockInvoke = vi.fn();
const mockFileDiff = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock("../lib/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/repo")>();
  return { ...actual, fileDiff: (...a: unknown[]) => mockFileDiff(...a) };
});

import { FileView } from "./FileView";

const textFile = (text: string) => ({
  rel_path: "notes.txt",
  size: text.length,
  modified_ms: 1,
  content: { kind: "text", text, truncated: false, lines: text.split("\n").length },
});

const emptyDiff = { binary: false, has_changes: false, from: null, to: null, lines: [], added: 0, removed: 0 };

const realDiff = {
  binary: false,
  has_changes: true,
  from: "notes.txt@21",
  to: "notes.txt",
  added: 1,
  removed: 1,
  lines: [
    { kind: "file_header", text: "--- notes.txt@21" },
    { kind: "hunk_header", text: "@@ -1,2 +1,2 @@" },
    { kind: "context", text: "unchanged line" },
    { kind: "removed", text: "gone" },
    { kind: "added", text: "arrived" },
  ],
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockFileDiff.mockReset();
});

describe("FileView", () => {
  it("prompts when nothing is selected", () => {
    render(<FileView root="/repo" rel={null} />);
    expect(screen.getByText("Select a file to view it.")).toBeInTheDocument();
  });

  it("explains a file that Lore marks changed but which has no differences", async () => {
    // The reference repository is 2163 files in exactly this state, so this is the common
    // case. It must never read as an error or an empty broken panel.
    mockInvoke.mockResolvedValue(textFile("hello"));
    mockFileDiff.mockResolvedValue(emptyDiff);

    render(<FileView root="/repo" rel="notes.txt" />);

    await waitFor(() =>
      expect(
        screen.getByText("Marked as changed, but the contents match the last revision."),
      ).toBeInTheDocument(),
    );
    // And it says why, in terms of what Lore reported rather than our own opinion.
    expect(screen.getByText(/Lore lists this file as changed/)).toBeInTheDocument();
  });

  it("renders a real diff with its added and removed lines", async () => {
    mockInvoke.mockResolvedValue(textFile("x"));
    mockFileDiff.mockResolvedValue(realDiff);

    render(<FileView root="/repo" rel="notes.txt" />);

    await waitFor(() => expect(screen.getByText("arrived")).toBeInTheDocument());
    expect(screen.getByText("gone")).toBeInTheDocument();
    expect(screen.getByText("unchanged line")).toBeInTheDocument();
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
  });

  it("says a changed binary has changed, rather than that it matches", async () => {
    // Found against a real modified .png. Falling through to "contents match" would tell an
    // artist their changed asset is unchanged.
    mockInvoke.mockResolvedValue(textFile("x"));
    mockFileDiff.mockResolvedValue({
      binary: true, has_changes: true, from: null, to: null, lines: [], added: 0, removed: 0,
    });

    render(<FileView root="/repo" rel="art/icon.png" />);

    await waitFor(() => expect(screen.getByText("This file has changed.")).toBeInTheDocument());
    expect(screen.getByText(/no lines to compare/)).toBeInTheDocument();
    expect(
      screen.queryByText("Marked as changed, but the contents match the last revision."),
    ).not.toBeInTheDocument();
  });

  it("shows the file contents on the File tab", async () => {
    mockInvoke.mockResolvedValue(textFile("line one\nline two"));
    mockFileDiff.mockResolvedValue(emptyDiff);

    render(<FileView root="/repo" rel="notes.txt" />);
    fireEvent.click(screen.getByText("File"));

    await waitFor(() => expect(screen.getByText(/line one/)).toBeInTheDocument());
  });

  it("previews an image", async () => {
    mockInvoke.mockResolvedValue({
      rel_path: "art/icon.png",
      size: 100,
      modified_ms: 1,
      content: { kind: "image", data_uri: "data:image/png;base64,AAAA", size: 100 },
    });
    mockFileDiff.mockResolvedValue(emptyDiff);

    render(<FileView root="/repo" rel="art/icon.png" />);
    fireEvent.click(screen.getByText("File"));

    const img = await screen.findByAltText("art/icon.png");
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
  });

  it("states why a binary file has no preview instead of showing nothing", async () => {
    mockInvoke.mockResolvedValue({
      rel_path: "Content/Hero.uasset",
      size: 4096,
      modified_ms: 1,
      content: { kind: "binary", size: 4096, reason: "Binary file, 4.0 KB." },
    });
    mockFileDiff.mockResolvedValue(emptyDiff);

    render(<FileView root="/repo" rel="Content/Hero.uasset" />);
    fireEvent.click(screen.getByText("File"));

    await waitFor(() => expect(screen.getByText("Binary file, 4.0 KB.")).toBeInTheDocument());
  });

  it("shows the file even when the diff fails", async () => {
    // A diff failure is not a reason to hide the file — they are separate questions.
    mockInvoke.mockResolvedValue(textFile("still readable"));
    mockFileDiff.mockRejectedValue(new Error("diff blew up"));

    render(<FileView root="/repo" rel="notes.txt" />);
    fireEvent.click(screen.getByText("File"));

    await waitFor(() => expect(screen.getByText(/still readable/)).toBeInTheDocument());
  });

  it("reports a diff failure instead of waiting forever", async () => {
    // The bug this exists for: the error was caught and discarded, so the pane sat on
    // "Comparing…" indefinitely. Silence is the one response a user cannot act on.
    mockInvoke.mockResolvedValue(textFile("x"));
    mockFileDiff.mockRejectedValue(new Error("something went wrong"));

    render(<FileView root="/repo" rel="notes.txt" />);

    await waitFor(() =>
      expect(screen.getByText("This file could not be compared.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Comparing…")).not.toBeInTheDocument();
  });

  it("explains a disconnected diff in terms of the connection, not the diff", async () => {
    // `lore diff` needs the base revision's contents, which live on the host. Offline it
    // fails with a storage error that names no cause the user could act on.
    mockInvoke.mockResolvedValue(textFile("x"));
    mockFileDiff.mockRejectedValue(
      new Error("`lore diff` failed: [Error] Disconnected from server"),
    );

    render(<FileView root="/repo" rel="test3.txt" />);

    await waitFor(() =>
      expect(
        screen.getByText("Cannot compare this file while disconnected."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/stored on the host/)).toBeInTheDocument();
  });

  it("keeps the raw error available for diagnosis", async () => {
    mockInvoke.mockResolvedValue(textFile("x"));
    mockFileDiff.mockRejectedValue(new Error("Address not found: 537cc107"));

    render(<FileView root="/repo" rel="test3.txt" />);

    await waitFor(() => expect(screen.getByText("Details")).toBeInTheDocument());
    expect(screen.getByText(/537cc107/)).toBeInTheDocument();
  });

  it("surfaces a read error rather than sitting on a spinner", async () => {
    mockInvoke.mockRejectedValue("notes.txt does not exist in this repository.");
    mockFileDiff.mockResolvedValue(emptyDiff);

    render(<FileView root="/repo" rel="notes.txt" />);

    await waitFor(() =>
      expect(screen.getByText(/does not exist in this repository/)).toBeInTheDocument(),
    );
  });

  it("reloads when the selection changes", async () => {
    mockInvoke.mockResolvedValue(textFile("first"));
    mockFileDiff.mockResolvedValue(emptyDiff);

    const { rerender } = render(<FileView root="/repo" rel="a.txt" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

    mockInvoke.mockResolvedValue(textFile("second"));
    rerender(<FileView root="/repo" rel="b.txt" />);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenLastCalledWith("read_file", { root: "/repo", rel: "b.txt" });
  });
});
