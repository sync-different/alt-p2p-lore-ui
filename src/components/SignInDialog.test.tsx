import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignInDialog } from "./SignInDialog";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

const b64url = (o: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jwt = (payload: unknown) => `${b64url({ alg: "ES256" })}.${b64url(payload)}.sig`;

const paste = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText(/^eyJ/), { target: { value: text } });

// Deliberately no shared reset: clearing a vi.fn() between tests makes a *handled* throw
// from a later implementation surface as an unhandled runner error. Each test sets what it
// needs, and assertions match any recorded call rather than a call count.

const identity = (user: string) => ({
  auth_url: "https://127.0.0.1:9443",
  resource: null,
  user,
  user_id: `u-${user}`,
  domains: [],
  expires_raw: "Fri, 14 Aug 2026 05:11:52 +0000",
  expires_ms: 1_786_684_312_000,
});

describe("SignInDialog", () => {
  it("lists identities already stored, because signing in adds to them", () => {
    // `lore` keeps an array per auth URL. Someone signing in as a second user has no way to
    // discover the first is still there — and the first is what a later permission error
    // will be about.
    render(
      <SignInDialog
        sessionName="Main"
        identityPort={9443}
        identities={[identity("ale"), identity("uitest")]}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/ale/)).toBeTruthy();
    expect(screen.getByText(/uitest/)).toBeTruthy();
    expect(screen.getByText(/lets lore choose/i)).toBeTruthy();
  });

  it("says that signing out is machine-wide, next to the button that does it", () => {
    // Reported from testing: "when I sign out in a session it also logs out of the other".
    // Correct behaviour, wrong expectation — set by a UI that put sign-out inside something
    // called a session. The fix for per-workspace users is “Acts as”, so say so here.
    render(
      <SignInDialog
        sessionName="Main"
        identityPort={9443}
        identities={[identity("ale")]}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/shared by every host and workspace/i)).toBeTruthy();
    expect(screen.getByText(/acts as/i)).toBeTruthy();
  });

  it("says nothing about ambiguity when only one identity is stored", () => {
    render(
      <SignInDialog
        sessionName="Main"
        identityPort={9443}
        identities={[identity("ale")]}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/lets lore choose/i)).toBeNull();
  });

  it("still signs an identity out with nothing connected", () => {
    // Signing out only edits the local store. Blocking it because the host is unreachable
    // would trap someone with a pinned identity they cannot get rid of.
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    render(
      <SignInDialog
        sessionName="Main"
        identityPort={9443}
        identities={[identity("ale")]}
        canSignIn={false}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole("button", { name: /sign out/i }).click();
    expect(mockInvoke).toHaveBeenCalledWith("auth_logout", expect.anything());
  });

  it("signs one identity out, naming it and never the whole URL", () => {
    // `auth logout` without --user-id removes *every* identity for the URL. Sending it is
    // the difference between switching user and locking yourself out.
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    const onDone = vi.fn();
    render(
      <SignInDialog
        sessionName="Main"
        identityPort={9443}
        identities={[identity("ale"), identity("uitest")]}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    screen.getAllByRole("button", { name: /sign out/i })[0].click();
    expect(mockInvoke).toHaveBeenCalledWith("auth_logout", {
      authUrl: "https://127.0.0.1:9443",
      userId: "u-ale",
    });
  });
  it("prefills the auth URL from the session's identity port", () => {
    // The field people get wrong: `lore` files the token under this exact string and looks
    // it up by it later, so a guess here fails much later and for no obvious reason.
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByDisplayValue("https://127.0.0.1:9443")).toBeTruthy();
  });

  it("will not send an empty token", () => {
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={() => {}} onCancel={() => {}} />);
    const btn = screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("says what was pasted before it is sent", () => {
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={() => {}} onCancel={() => {}} />);
    paste(jwt({ name: "ale", exp: Date.now() / 1000 + 7200 }));
    expect(screen.getByText(/for ale · valid 2h/i)).toBeTruthy();
  });

  it("warns about an already-expired token without blocking it", () => {
    // The likely mistake: the token in the chat window is the old one. Saying so is worth
    // more than refusing — the host is what decides whether a token is good.
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={() => {}} onCancel={() => {}} />);
    paste(jwt({ name: "ale", exp: Date.now() / 1000 - 60 }));
    expect(screen.getByText(/already expired/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the token, its type and the auth URL, and reports success", async () => {
    mockInvoke.mockResolvedValue("");
    const onDone = vi.fn();
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={onDone} onCancel={() => {}} />);

    const token = jwt({ name: "ale", exp: Date.now() / 1000 + 3600 });
    paste(token);
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockInvoke).toHaveBeenCalledWith("auth_login_token", {
      token,
      tokenType: "lore",
      authUrl: "https://127.0.0.1:9443",
    });
    expect(onDone.mock.calls[0][0]).toContain("Main");
  });

  it("shows what lore said when it refuses, unedited", async () => {
    // A wrong auth URL and a rejected token are indistinguishable from here, so inventing
    // a friendlier sentence would send people to the wrong one of the two.
    mockInvoke.mockImplementation(() => {
      throw "`lore auth login` failed: invalid token signature";
    });
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={() => {}} onCancel={() => {}} />);

    paste(jwt({ exp: Date.now() / 1000 + 3600 }));
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText(/invalid token signature/i)).toBeTruthy());
  });

  it("does not report success when the sign-in failed", async () => {
    // The failure worth guarding: a dialog that closes on error leaves someone believing
    // they are signed in until the next command fails.
    mockInvoke.mockImplementation(() => {
      throw "nope";
    });
    const onDone = vi.fn();
    render(<SignInDialog sessionName="Main" identityPort={9443} onDone={onDone} onCancel={() => {}} />);

    paste(jwt({ exp: Date.now() / 1000 + 3600 }));
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });
});
