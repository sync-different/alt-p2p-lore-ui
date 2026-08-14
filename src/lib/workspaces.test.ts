import { describe, expect, it } from "vitest";
import { displayLabels, siblingsOf, workspaceHealth, type WorkspaceSummary } from "./workspaces";
import type { ServingHost } from "./reachability";

/**
 * "Can I work here?" — a question about the repository, not about which tab is selected.
 *
 * Established by hand before this existed: a repository in a *disconnected* tab worked fine,
 * because another tab's tunnel was listening on the port it dials. The tab colour said
 * otherwise, which is the confusion this replaces.
 */

const ws = (over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: "w1",
  path: "/work/demo",
  name: "demo",
  exists: true,
  remote_url: "grpc://127.0.0.1:41400",
  remote_port: 41400,
  identity: null,
  repository_id: "019f9e",
  instance_id: "aaaa",
  ...over,
});

const tunnel = (port: number, available = true): ServingHost => ({
  name: "main",
  baseUrl: `grpc://127.0.0.1:${port}`,
  available,
  isP2p: true,
});

describe("workspaceHealth", () => {
  it("is ready when any live tunnel serves its port", () => {
    expect(workspaceHealth(ws(), [tunnel(41400)], [])).toBe("ready");
  });

  it("is ready even though the tunnel belongs to a different host", () => {
    // The whole point: lore dials a loopback port and cannot see tabs.
    const other: ServingHost = { name: "some other host", baseUrl: "grpc://127.0.0.1:41400", available: true, isP2p: true };
    expect(workspaceHealth(ws(), [other], [])).toBe("ready");
  });

  it("is unreachable when nothing is listening on its port", () => {
    expect(workspaceHealth(ws(), [tunnel(41501)], [])).toBe("unreachable");
    expect(workspaceHealth(ws(), [], [])).toBe("unreachable");
    expect(workspaceHealth(ws(), [tunnel(41400, false)], [])).toBe("unreachable");
  });

  it("flags a pinned identity that is not signed in", () => {
    // Every call would fail with "No token stored" — true, and nothing about that message
    // points at the repository.
    expect(workspaceHealth(ws({ identity: "u-87c4" }), [tunnel(41400)], ["u-99f5"])).toBe(
      "signed_out",
    );
    expect(workspaceHealth(ws({ identity: "u-87c4" }), [tunnel(41400)], ["u-87c4"])).toBe("ready");
  });

  it("does not care about identity for an unpinned repository", () => {
    expect(workspaceHealth(ws({ identity: null }), [tunnel(41400)], [])).toBe("ready");
  });

  it("reports a missing folder above everything else", () => {
    // Nothing to reach and nothing to sign in to; a moved clone must not look merely offline.
    expect(workspaceHealth(ws({ exists: false, identity: "u-87c4" }), [], [])).toBe("missing");
  });

  it("says unknown rather than guessing when there is no remote", () => {
    // A locally created repository. Calling it unreachable would invite a fix that does not
    // apply.
    expect(workspaceHealth(ws({ remote_port: null, remote_url: null }), [tunnel(41400)], [])).toBe(
      "unknown",
    );
  });

  it("puts unreachable ahead of signed-out", () => {
    // Signing in would not help while nothing is listening; ordering the other way sends
    // people to fix the wrong thing first.
    expect(workspaceHealth(ws({ identity: "u-87c4" }), [], [])).toBe("unreachable");
  });
});

describe("displayLabels", () => {
  const w = (id: string, name: string, path: string): WorkspaceSummary => ({
    id,
    name,
    path,
    exists: true,
    remote_url: "grpc://127.0.0.1:41400",
    remote_port: 41400,
    identity: null,
    repository_id: "019f9e",
    instance_id: id,
  });

  it("leaves a unique name alone", () => {
    const l = displayLabels([w("1", "demo", "/Users/a/demo-ctone/demo")]);
    expect(l.get("1")).toBe("demo");
  });

  it("separates two clones of one repository by their folders", () => {
    // Reported from testing: "I have demo cloned in 2 folders. The tabs both appear as demo
    // and the activity events are both demo."
    const l = displayLabels([
      w("1", "demo", "/Users/a/demo-ctone/demo"),
      w("2", "demo", "/Users/a/demo-ctone2/demo"),
    ]);
    expect(l.get("1")).toBe("demo-ctone/demo");
    expect(l.get("2")).toBe("demo-ctone2/demo");
  });

  it("takes as much path as it needs, and no more", () => {
    const l = displayLabels([
      w("1", "demo", "/Users/a/work/2026/alpha/demo"),
      w("2", "demo", "/Users/a/work/2026/beta/demo"),
    ]);
    // One parent is enough to tell these apart; adding "2026/" would be noise.
    expect(l.get("1")).toBe("alpha/demo");
    expect(l.get("2")).toBe("beta/demo");
  });

  it("goes deeper when one parent is not enough", () => {
    const l = displayLabels([
      w("1", "demo", "/Users/a/alpha/src/demo"),
      w("2", "demo", "/Users/a/beta/src/demo"),
    ]);
    expect(l.get("1")).toBe("alpha/src/demo");
    expect(l.get("2")).toBe("beta/src/demo");
  });

  it("respects a name the user chose, when it is unique", () => {
    // Renaming is the better fix; this must not fight it.
    const l = displayLabels([
      w("1", "as ale", "/Users/a/demo-ctone/demo"),
      w("2", "as uitest", "/Users/a/demo-ctone2/demo"),
    ]);
    expect(l.get("1")).toBe("as ale");
    expect(l.get("2")).toBe("as uitest");
  });

  it("terminates when two entries share a path", () => {
    // No prefix can separate the same folder from itself; it must not loop forever.
    const l = displayLabels([
      w("1", "demo", "/Users/a/demo"),
      w("2", "demo", "/Users/a/demo"),
    ]);
    expect(l.size).toBe(2);
  });
});

describe("siblingsOf", () => {
  const clone = (id: string, name: string, repo: string | null): WorkspaceSummary => ({
    id,
    name,
    path: `/work/${name}`,
    exists: true,
    remote_url: "grpc://127.0.0.1:41400",
    remote_port: 41400,
    identity: null,
    repository_id: repo,
    instance_id: `i-${id}`,
  });

  it("finds the other clones of one repository", () => {
    // Lore supports several instances of one repository on one machine, each with its own
    // branch and identity — this is what turns two confusingly similar tabs into a pair.
    const all = [clone("1", "as ale", "019f9e"), clone("2", "as uitest", "019f9e"), clone("3", "other", "01a0b1")];
    expect(siblingsOf(all[0], all).map((w) => w.name)).toEqual(["as uitest"]);
    expect(siblingsOf(all[2], all)).toEqual([]);
  });

  it("never claims kinship on a missing id", () => {
    // Two workspaces whose repository could not be read are not thereby related.
    const all = [clone("1", "a", null), clone("2", "b", null)];
    expect(siblingsOf(all[0], all)).toEqual([]);
  });
});

describe("identity only matters where the host asks for it", () => {
  // Reported from testing: a workspace on a host with no sign-in showed yellow because it
  // carried a pin, while an equivalent one on an authenticated host showed green. The pin is
  // inert there — that workspace had been committing and pushing all along — and a warning
  // about nothing teaches people to ignore the colour.
  const pinned: WorkspaceSummary = {
    id: "w1",
    name: "atlas",
    path: "/work/atlas",
    exists: true,
    remote_url: "grpc://127.0.0.1:51337",
    remote_port: 51337,
    identity: "u-87c4",
    repository_id: "019ffe",
    instance_id: "i1",
  };
  const host: ServingHost = {
    name: "atlas-test",
    baseUrl: "grpc://127.0.0.1:51337",
    available: true,
    isP2p: false,
  };

  it("is ready when the host needs no sign-in, whatever the pin says", () => {
    expect(workspaceHealth(pinned, [host], [], false)).toBe("ready");
  });

  it("still flags a signed-out pin where the host does require it", () => {
    expect(workspaceHealth(pinned, [host], [], true)).toBe("signed_out");
    expect(workspaceHealth(pinned, [host], ["u-87c4"], true)).toBe("ready");
  });
});
