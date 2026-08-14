import { describe, expect, it } from "vitest";
import { describePreview, previewToken } from "./jwt";

/**
 * Reading a pasted token well enough to say what it is.
 *
 * Not verification — this app holds no keys and the host is the judge. The value is in
 * catching the mistake people actually make: pasting the token that was already in the chat
 * window, which is last week's. Finding that out from a failed clone an hour later is the
 * experience the whole expiry milestone exists to prevent.
 */

const b64url = (o: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const jwt = (payload: unknown) =>
  `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;

const NOW = 1_786_000_000_000;

describe("previewToken", () => {
  it("reads who a token is for and when it runs out", () => {
    const p = previewToken(jwt({ sub: "u-87c4", name: "ale", exp: NOW / 1000 + 3600 }));
    expect(p.subject).toBe("u-87c4");
    expect(p.name).toBe("ale");
    expect(p.expiresMs).toBe(NOW + 3_600_000);
    expect(p.problem).toBeUndefined();
  });

  it("treats exp as seconds, as the spec says", () => {
    // Reading it as milliseconds would put every token fifty thousand years out and report
    // all of them, including expired ones, as comfortably valid.
    const p = previewToken(jwt({ exp: 1_786_684_312 }));
    expect(p.expiresMs).toBe(1_786_684_312_000);
  });

  it("names repository grants when the token scopes any", () => {
    // Authorization is per repository here, so a token that grants none is worth noticing
    // before it produces a "Not found" against a repo the user can see.
    const p = previewToken(jwt({ sub: "u1", resources: ["019f9e", "01a0b1"] }));
    expect(p.resources).toEqual(["019f9e", "01a0b1"]);
  });

  it("survives a name with characters outside ASCII", () => {
    // A byte-for-char read mangles these; the paste box is exactly where a real name lands.
    const p = previewToken(jwt({ name: "Renée Ångström" }));
    expect(p.name).toBe("Renée Ångström");
  });

  it("says a truncated paste is truncated rather than guessing", () => {
    expect(previewToken("eyJhbGciOiJFUzI1NiJ9").problem).toMatch(/three parts/i);
    expect(previewToken("not.a.token").problem).toMatch(/could not be read/i);
    expect(previewToken("").problem).toBeTruthy();
  });
});

describe("describePreview", () => {
  it("warns before sending when the token has already expired", () => {
    const { text, bad } = describePreview(
      previewToken(jwt({ name: "ale", exp: NOW / 1000 - 60 })),
      NOW,
    );
    expect(bad).toBe(true);
    expect(text).toMatch(/already expired/i);
    expect(text).toContain("ale");
  });

  it("says how long a good token lasts", () => {
    const { text, bad } = describePreview(
      previewToken(jwt({ name: "ale", exp: NOW / 1000 + 12 * 3600 })),
      NOW,
    );
    expect(bad).toBe(false);
    expect(text).toMatch(/valid 12h/);
  });

  it("is honest about a token with no expiry rather than implying one", () => {
    const { text, bad } = describePreview(previewToken(jwt({ sub: "u1" })), NOW);
    expect(bad).toBe(false);
    expect(text).toMatch(/no expiry/i);
  });

  it("flags an unreadable token but leaves the decision to the host", () => {
    // The preview is a courtesy, not an authority: it may not refuse a token it cannot
    // parse, because the server is what decides whether a token is good.
    const { bad } = describePreview(previewToken("garbage"), NOW);
    expect(bad).toBe(true);
  });
});
