import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionForm } from "./SessionForm";
import type { SessionConfig } from "../lib/sessions";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

const existing: SessionConfig & { hasKey?: boolean } = {
  id: "s1",
  name: "daniel",
  session_id: "lore-dc-1",
  server: "coord.example.com:9000",
  loreserver_port: 41400,
  identity_port: 9443,
  allow_relay: true,
  hasKey: true,
};

describe("SessionForm deletion", () => {
  it("offers no delete when adding, since there is nothing to delete", () => {
    render(<SessionForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("asks twice before deleting", () => {
    // One stray click should not remove a session someone has to retype from scratch.
    mockInvoke.mockImplementation(() => Promise.resolve([]));
    const onDeleted = vi.fn();
    render(<SessionForm existing={existing} onSaved={() => {}} onDeleted={onDeleted} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /click again/i })).toBeTruthy();
  });

  it("deletes by id on the second click and reports it", async () => {
    mockInvoke.mockImplementation(() => Promise.resolve([]));
    const onDeleted = vi.fn();
    render(<SessionForm existing={existing} onSaved={() => {}} onDeleted={onDeleted} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /click again/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(existing));
    expect(mockInvoke).toHaveBeenCalledWith("delete_session", { id: "s1" });
  });

  it("keeps the session when deleting fails", async () => {
    // Reporting a deletion that did not happen would leave the tab gone from the UI and the
    // config still on disk, to reappear at the next launch.
    mockInvoke.mockImplementation(() => {
      throw "keychain locked";
    });
    const onDeleted = vi.fn();
    render(<SessionForm existing={existing} onSaved={() => {}} onDeleted={onDeleted} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /click again/i }));

    await waitFor(() => expect(screen.getByText(/keychain locked/)).toBeTruthy());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
