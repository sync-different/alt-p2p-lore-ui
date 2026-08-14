import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloneDialog } from "./CloneDialog";

const mockInvoke = vi.fn();
// Two commands reach the same mock now; unless a test says otherwise, the host lists nothing
// and the dialog falls back to its text field.
const answersWith = (
  repos: { name: string; id: string }[],
  clone?: () => unknown,
  who: typeof identities = [],
) =>
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_repositories") return Promise.resolve(repos);
    // The dialog asks for the chosen host's identities itself, since a different host means a
    // different auth URL and so a different store.
    if (cmd === "auth_status") return Promise.resolve({ identities: who, expiry: {}, all: who });
    return clone ? clone() : Promise.resolve("/work/new");
  });
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve("/work/new") }));

const oneHost = {
  id: "h1",
  name: "main",
  baseUrl: "grpc://127.0.0.1:41400",
  authUrl: "https://127.0.0.1:9443",
};

const identities = [
  { auth_url: "u", resource: null, user: "ale", user_id: "u-ale", domains: [], expires_raw: null, expires_ms: null },
  { auth_url: "u", resource: null, user: "uitest", user_id: "u-uitest", domains: [], expires_raw: null, expires_ms: null },
];

const type = (placeholder: RegExp, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

describe("CloneDialog", () => {
  it("offers the repositories the host says this identity may clone", async () => {
    // The point of implementing LookupUserPermissions: nobody should have to know a name,
    // let alone an id.
    answersWith([
      { name: "demo", id: "019f9e" },
      { name: "concept-art", id: "01a0b1" },
    ]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);

    await waitFor(() => expect(screen.getByRole("option", { name: "demo" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "concept-art" })).toBeTruthy();
  });

  it("chooses for you when the host offers exactly one", async () => {
    answersWith([{ name: "demo", id: "019f9e" }]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);

    await waitFor(() => expect(screen.getByText("grpc://127.0.0.1:41400/demo")).toBeTruthy());
  });

  it("says an empty list means no access, not a broken host", async () => {
    answersWith([]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);

    await waitFor(() => expect(screen.getByText(/no repositories on that host/i)).toBeTruthy());
  });

  it("falls back to typing when the list cannot be fetched", async () => {
    // The list is a convenience; losing it must not stop someone who knows the name.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_repositories") return Promise.reject("host unreachable");
      return Promise.resolve("/work/new");
    });
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);

    await waitFor(() => expect(screen.getByText(/type the name your host gave you/i)).toBeTruthy());
    expect(screen.getByPlaceholderText(/^demo$/)).toBeTruthy();
  });

  it("never asks anyone for an id, in either mode", async () => {
    answersWith([]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/^demo$/)).toBeTruthy());
    expect(screen.queryByText(/019f9e9f8f157e12a7ab77330299cfd4/)).toBeNull();
  });

  it("builds the address from the connected host's port", () => {
    render(<CloneDialog hosts={[{ ...oneHost, baseUrl: "grpc://127.0.0.1:41501" }]} onCloned={() => {}} onCancel={() => {}} />);
    type(/^demo$/, "demo");
    expect(screen.getByText("grpc://127.0.0.1:41501/demo")).toBeTruthy();
  });

  it("will not start without both a repository and a destination", () => {
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);
    const btn = () => screen.getByRole("button", { name: /^clone$/i }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    type(/^demo$/, "demo");
    expect(btn().disabled).toBe(true);
    type(/Users\/you/, "/work/new");
    expect(btn().disabled).toBe(false);
  });

  it("asks which host to clone from when more than one is connected", async () => {
    // Two hosts can be connected at once whenever they are genuinely different hosts — two
    // sessions to *one* host cannot, since its identity port binds once. The choice decides
    // both the repository list and the identities, so it must not be guessed.
    answersWith([{ name: "demo", id: "019f9e" }]);
    render(
      <CloneDialog
        hosts={[oneHost, { id: "h2", name: "studio", baseUrl: "grpc://127.0.0.1:41600", authUrl: "https://127.0.0.1:9444" }]}
        onCloned={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole("option", { name: /main · grpc:\/\/127.0.0.1:41400/ })).toBeTruthy());
    expect(screen.getByRole("option", { name: /studio · grpc:\/\/127.0.0.1:41600/ })).toBeTruthy();
  });

  it("asks nothing when there is only one host", async () => {
    answersWith([{ name: "demo", id: "019f9e" }]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "demo" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /grpc:\/\/127.0.0.1:41400/ })).toBeNull();
  });

  it("re-lists against the host that is chosen", async () => {
    answersWith([{ name: "demo", id: "019f9e" }]);
    render(
      <CloneDialog
        hosts={[oneHost, { id: "h2", name: "studio", baseUrl: "grpc://127.0.0.1:41600", authUrl: "https://127.0.0.1:9444" }]}
        onCloned={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue(/main/), { target: { value: "h2" } });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("list_repositories", {
        url: "grpc://127.0.0.1:41600",
        identity: null,
      }),
    );
  });

  it("says so plainly when no host is connected", () => {
    render(<CloneDialog hosts={[]} onCloned={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/no host is connected/i)).toBeTruthy();
  });

  it("passes the chosen identity, which the clone keeps for good", async () => {
    // `lore` records it into the new working copy's config, so this choice is what the
    // workspace will act as from then on — the thing that makes two clones two users.
    answersWith([], undefined, identities);
    const onCloned = vi.fn();
    render(
      <CloneDialog
        hosts={[oneHost]}
        defaultIdentity="u-uitest"
        onCloned={onCloned}
        onCancel={() => {}}
      />,
    );
    type(/^demo$/, "demo");
    type(/Users\/you/, "/work/new");
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/work/new"));
    expect(mockInvoke).toHaveBeenCalledWith(
      "clone_repo",
      expect.objectContaining({
        url: "grpc://127.0.0.1:41400/demo",
        dest: "/work/new",
        identity: "u-uitest",
        // Off unless asked for: the shared store is machine-wide.
        sharedStore: false,
      }),
    );
  });

  it("sends null rather than an empty identity when none is chosen", async () => {
    // An empty string would be recorded as an identity named "", which can never be found.
    answersWith([]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);
    type(/^demo$/, "demo");
    type(/Users\/you/, "/work/new");
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    const last = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    expect(last[1]).toMatchObject({ identity: null });
  });

  it("can share storage with clones already on this machine", async () => {
    // Lore's design: instances share immutable fragments through one store, so a second clone
    // of a 2 GiB repository is a fraction of the first in time and disk.
    answersWith([{ name: "demo", id: "019f9e" }]);
    render(<CloneDialog hosts={[oneHost]} onCloned={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "demo" })).toBeTruthy());
    type(/Users\/you/, "/work/new");
    fireEvent.click(screen.getByRole("checkbox", { name: /share storage/i }));
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("clone_repo", expect.objectContaining({ sharedStore: true })));
  });

  it("stays open afterwards and says what the clone came to", async () => {
    // Reported from testing: "when cloning completes the popup disappears and the user can't
    // even see the final stats." The summary is the one moment it is worth reading.
    answersWith([{ name: "demo", id: "019f9e" }]);
    const onCloned = vi.fn();
    render(<CloneDialog hosts={[oneHost]} onCloned={onCloned} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "demo" })).toBeTruthy());
    type(/Users\/you/, "/work/new");
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    // The summary is populated by the terminating event, which the mocked listener does not
    // deliver; what matters here is that the dialog stays and offers Done.
    await waitFor(() => expect(screen.getByRole("button", { name: /^done$/i })).toBeTruthy());
    // The workspace is added straight away; only the window waits.
    expect(onCloned).toHaveBeenCalledWith("/work/new");
    // And no second clone can be started over the top of the first.
    expect(screen.queryByRole("button", { name: /^clone$/i })).toBeNull();
  });

  it("shows what lore said when the clone fails, and stays open", async () => {
    // A dialog that closes on failure loses the only explanation there was.
    answersWith([], () => {
      throw "Failed to clone: Not authorized to access repository";
    });
    const onCloned = vi.fn();
    render(<CloneDialog hosts={[oneHost]} onCloned={onCloned} onCancel={() => {}} />);
    type(/^demo$/, "demo");
    type(/Users\/you/, "/work/new");
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(screen.getByText(/not authorized/i)).toBeTruthy());
    expect(onCloned).not.toHaveBeenCalled();
  });
});
