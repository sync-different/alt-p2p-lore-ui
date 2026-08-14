import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthBadge } from "./AuthBadge";
import type { AuthStatus } from "../lib/auth";

const identity = (user: string, expires = "Fri, 14 Aug 2026 05:11:52 +0000") => ({
  auth_url: "https://127.0.0.1:9443",
  resource: null,
  user,
  user_id: `u-${user}`,
  domains: [],
  expires_raw: expires,
  expires_ms: 1_786_684_312_000,
});

const status = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  identities: [identity("ale")],
  expiry: { state: "valid", minutes: 300 },
  all: [],
  ...over,
});

describe("AuthBadge", () => {
  it("still reports who is signed in while nothing is connected", () => {
    // `lore auth list` reads a local file: the answer is knowable offline, and hiding it is
    // worst exactly when someone is looking for it.
    render(<AuthBadge status={status()} connected={false} identityPort={9443} />);
    expect(screen.getByText(/signed in as ale/i)).toBeTruthy();
  });

  it("can always be opened, because signing out is a local operation", () => {
    // The report: "it appears but is not clickable to change user". Tokens are filed per
    // auth URL, not per host, so the selected host being down says nothing about whether
    // the identity store can be changed.
    const onSignIn = vi.fn();
    render(<AuthBadge status={status()} connected={false} identityPort={9443} onSignIn={onSignIn} />);
    screen.getByText(/signed in as ale/i).click();
    expect(onSignIn).toHaveBeenCalled();
  });

  it("will not offer a sign-in without a connection, since that contacts the host", () => {
    render(
      <AuthBadge
        status={status({ expiry: { state: "missing" } })}
        connected={false}
        identityPort={9443}
        onSignIn={() => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: /sign in/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("says so when the session has no identity port, rather than showing nothing", () => {
    // Reported from testing: "I don't see any sign in button in the toolbar after
    // connecting." All three saved sessions had no identity port, so the correct render was
    // an empty toolbar — indistinguishable from a broken feature. This is the one place
    // someone would look to find out why.
    const onConfigure = vi.fn();
    render(<AuthBadge status={null} connected identityPort={null} onConfigure={onConfigure} />);
    const el = screen.getByText(/no sign-in configured/i);
    expect(el).toBeTruthy();
    expect(el.getAttribute("title")).toMatch(/identity port/i);

    // And it leads somewhere: clicking opens the settings that fix it.
    el.click();
    expect(onConfigure).toHaveBeenCalled();
  });

  it("waits for a state before saying anything about a configured session", () => {
    const { container } = render(<AuthBadge status={null} connected identityPort={9443} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers a sign-in only when one is actually needed", () => {
    const { rerender } = render(<AuthBadge status={status()} connected identityPort={9443} onSignIn={() => {}} />);
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();

    rerender(
      <AuthBadge status={status({ expiry: { state: "expired", minutes: 5 } })} connected identityPort={9443} onSignIn={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
  });

  it("does not interrupt work that is still valid, even close to the edge", () => {
    render(<AuthBadge status={status({ expiry: { state: "soon", minutes: 12 } })} connected identityPort={9443} onSignIn={() => {}} />);
    expect(screen.getByText(/expires in 12 min/i)).toBeTruthy();
    // Still working: a sign-in button here would push people to re-authenticate mid-task.
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });

  it("distinguishes 'cannot read the state' from 'signed out'", () => {
    // Failing to read local state is a local fault. Showing it as signed-out would send
    // someone through a browser sign-in that fixes nothing.
    render(<AuthBadge status={null} error="lore auth list failed" connected identityPort={9443} onSignIn={() => {}} />);
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });

  it("carries the exact expiry time in the hover, not just the rounded label", () => {
    render(<AuthBadge status={status()} connected identityPort={9443} />);
    const el = screen.getByText(/signed in/i);
    expect(el.getAttribute("title")).toContain("Fri, 14 Aug 2026 05:11:52 +0000");
  });

  it("names its host when several are connected and nothing else says which", () => {
    // Sign-in is per auth URL and so per host. With two connected, an unlabelled badge is a
    // true statement about a store the user cannot identify.
    render(
      <AuthBadge status={status()} connected identityPort={9443} hostName="studio" />,
    );
    expect(screen.getByText(/studio/)).toBeTruthy();
  });

  it("stays quiet about the host when there is nothing to disambiguate", () => {
    render(<AuthBadge status={status()} connected identityPort={9443} />);
    expect(screen.getByText(/signed in as ale/i).textContent).not.toMatch(/·.*·/);
  });

  it("shows only the pinned identity when the workspace has chosen one", () => {
    render(
      <AuthBadge
        status={status({ identities: [identity("ale"), identity("uitest")], expiry: { state: "valid", minutes: 700 } })}
        connected
        identityPort={9443}
        pinnedIdentity="u-uitest"
      />,
    );
    expect(screen.getByText(/signed in as uitest/i)).toBeTruthy();
    expect(screen.queryByText(/ale, uitest/)).toBeNull();
  });

  it("names every identity when more than one is stored and none is pinned", () => {
    // Observed live: signing in as uitest *added* an identity, and the badge still read
    // "Signed in as ale" — a sign-in that had worked looked like one that had not. Which
    // identity lore uses is its choice, so naming one would be a guess stated as fact.
    render(
      <AuthBadge
        status={status({ identities: [identity("ale"), identity("uitest")] })}
        connected
        identityPort={9443}
      />,
    );
    // The count is gone: the label now names whose clock the countdown belongs to, which is
    // more useful than saying how many there are.
    const el = screen.getByText(/ale, uitest/);
    expect(el.textContent).toMatch(/ale/);
    // The advice changed with the model: pinning a workspace is now the way to make it
    // definite, and signing out is a machine-wide operation rather than a disambiguator.
    expect(el.getAttribute("title")).toMatch(/acts as/i);
  });

  it("lets a working session sign in again, to renew early or switch user", () => {
    // Both are things people do while a token still works. A control that appears only on
    // expiry cannot be used to avoid one.
    const onSignIn = vi.fn();
    render(<AuthBadge status={status()} connected identityPort={9443} onSignIn={onSignIn} />);
    screen.getByText(/signed in as ale/i).click();
    expect(onSignIn).toHaveBeenCalled();
  });

});
