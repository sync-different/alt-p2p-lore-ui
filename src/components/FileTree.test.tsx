import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileTree } from "./FileTree";
import type { VisibleRow } from "../lib/tree";
import type { ChangeKind, DirEntry } from "../lib/repo";

/**
 * jsdom reports every element as zero-height, so a virtualizer would conclude that no rows
 * are visible and render nothing. Give the scroll container a real size so the windowing
 * maths has something to work with — otherwise these tests would pass against a component
 * that renders an empty list.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 300 });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 300, height: 600, top: 0, left: 0, bottom: 600, right: 300, x: 0, y: 0, toJSON: () => {} }),
  });
});

const entry = (rel: string, is_dir = false): DirEntry => ({
  name: rel.split("/").pop()!,
  rel_path: rel,
  is_dir,
  size: 100,
  modified_ms: 1,
  is_binary: rel.endsWith(".uasset"),
});

const row = (rel: string, opts: Partial<VisibleRow> & { is_dir?: boolean } = {}): VisibleRow => ({
  entry: entry(rel, opts.is_dir ?? false),
  depth: opts.depth ?? 0,
  expanded: opts.expanded ?? false,
  loading: opts.loading ?? false,
});

const renderTree = (rows: VisibleRow[], changes = new Map<string, ChangeKind>(), handlers = {}) =>
  render(
    <FileTree
      rows={rows}
      changes={changes}
      selected={null}
      onSelect={vi.fn()}
      onToggle={vi.fn()}
      empty="Nothing here."
      {...handlers}
    />,
  );

describe("FileTree", () => {
  it("shows the empty message when there are no rows", () => {
    renderTree([]);
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  });

  it("renders file and directory names", () => {
    renderTree([row("Content", { is_dir: true }), row("README.md")]);
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("calls onToggle for a directory and onSelect for a file", () => {
    // Clicking a folder should open it, not select it — they are different intents and
    // wiring both to one handler is an easy mistake to make.
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    renderTree([row("Content", { is_dir: true }), row("README.md")], new Map(), { onSelect, onToggle });

    fireEvent.click(screen.getByText("Content"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("README.md"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows a change badge for changed paths only", () => {
    const changes = new Map<string, ChangeKind>([["README.md", "modified"]]);
    renderTree([row("README.md"), row("other.txt")], changes);
    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("shows an unrecognised change code rather than hiding the file", () => {
    const changes = new Map<string, ChangeKind>([["x.txt", { other: "R" }]]);
    renderTree([row("x.txt")], changes);
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("indents by depth", () => {
    renderTree([row("a", { is_dir: true }), row("a/b.txt", { depth: 1 })]);
    const nested = screen.getByText("b.txt").closest("button")!;
    const top = screen.getByText("a").closest("button")!;
    expect(parseInt(nested.style.paddingLeft)).toBeGreaterThan(parseInt(top.style.paddingLeft));
  });

  it("virtualizes: a huge list does not render a row per file", () => {
    // The reference repository reports all 2163 of its files as changed, so this is the
    // ordinary case rather than a stress test. Rendering them all makes scrolling unusable.
    const many = Array.from({ length: 2163 }, (_, i) => row(`Content/file${i}.uasset`));
    renderTree(many);

    const rendered = screen.getByTestId("file-tree").querySelectorAll("button").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });
});
