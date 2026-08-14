# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project Overview

**alt-lore Desktop** — a Tauri desktop app for working with [EpicGames Lore](https://epicgames.github.io/lore/)
repositories over a peer-to-peer tunnel. It wraps two programs it does not own:

- **`lore`** — the Lore CLI, bundled as a sidecar. Has no machine-readable output, so every
  interaction is text parsed against golden fixtures captured from the real thing.
- **`alt-p2p-lore`** — the P2P tunnel (a shaded [alt-p2p](https://github.com/sync-different/alt-p2p)
  jar), which makes a remote loreserver and identity provider appear at loopback addresses.
  It is one way to reach a host; a host can equally be a plain address on the network.

The audience is artists and developers, not operators. That shapes everything below: an error
must name the thing to change, and a green light must be one the app can justify.

## Build & Test

```bash
./scripts/fetch-deps.sh      # stage lore, the jar and a jlink JRE into src-tauri/ (never committed)
npm install
npm run tauri dev            # development
npm run tauri build -- --bundles app

npm test -- --run            # vitest (frontend)
cd src-tauri && cargo test   # Rust
```

Both suites must pass; `npm run build` also typechecks. **[ARCHITECTURE.md](ARCHITECTURE.md)**
covers how the app is put together and why. Milestone plans and the working notes behind the
domain model live in `internal/`, which is not tracked.

## Architecture

```
src/                    React 19 + TS. Components are dumb; lib/ holds the decisions and the tests.
  lib/                  auth, workspaces, reachability, clone, repo, tree — pure, tested
  hooks/                useTunnels, useAuth, useRepository, useNotices
src-tauri/src/
  lore/                 cmd (run + redact), auth, repo, clone, content, parse
  tunnel/               event, supervisor (NDJSON from `connect --json`)
  registry.rs           live tunnel processes — Rust owns them, the UI holds ids
  workspace.rs          workspaces.json + summaries read from .lore without running anything
  session.rs            hosts (sessions.json) + PSKs in the OS keychain
  orphans.rs            reaping tunnels a previous run left behind
```

**Hosts are addresses; workspaces are the work.** A tab is a *workspace* — a working copy plus
the identity it acts as — never a P2P session. A host is identified by the URL its working
copies dial: derived from the forwarded port for P2P (`grpc://127.0.0.1:<port>`), given outright
for a direct host. Never key anything on the port alone — that made any two hosts on one port
the same host. [ARCHITECTURE.md](ARCHITECTURE.md) explains why.

## The Lore model — the four facts that bite hardest

All verified by hand against a live host. Getting any of them wrong produces a UI that looks
right with one host, one identity and one clone:

- **A working copy pins its host as a URL** (`remote_url` in `.lore/config.toml`), not a
  session. Whichever host serves that URL serves it — a repo in a *disconnected* tab works
  through another tab's tunnel. Matching is on the **authority** (`host:port`), because the two
  URLs compared are written by different programs and differ in paths and trailing slashes.
- **A working copy may pin an identity** (`identity = "u-…"`, honoured with no flag). `--identity`
  takes the **user id**, never the username. This is the *only* mechanism that makes two clones
  act as two people.
- **Identities are stored per auth URL, for the whole machine**, and `[[remotes.token]]` is an
  array — signing in **adds**. So "sign out to switch user" is wrong, and signing out affects
  every workspace.
- **One tunnel per host**: the identity port binds once. Two P2P sessions to one host can both
  be configured and only one can connect. A **direct** host has no tunnel at all, so no such
  limit — and `kind` defaults to `p2p`, so configurations written before direct hosts existed
  load unchanged.

`.lore/id` and `.lore/instance` are 16 raw bytes each — the repository and this working copy.
Both readable without running `lore`, and the only identifiers that survive renaming a folder.

## Critical implementation notes

### `lore clone` draws its progress bar only for a terminal

No flag turns it on (the CLI reference has no `--progress`; the presence of `--non-interactive`
is the tell). Piped, it prints five lines and says nothing for the 99 seconds between them.
`--log-level debug` adds 10,000 lines of other things. So the app spawns it through a
**pseudo-terminal** (`portable-pty`, `TERM=xterm-256color`, 120 columns) and parses:

```
[█████████████       ] 536/818+  128.92 MiB/1.85 GiB
```

Two things that are easy to get wrong: output must be split on **`\r` as well as `\n`** (the bar
redraws with carriage returns and never a newline — waiting for lines means waiting for the whole
clone), and the percentage must come from **bytes, not files** (the `+` means lore is still
counting, so a file-based percentage runs backwards as the denominator grows).

The closing lines carry erase codes (`ESC[K`, `ESC[2K`) and are the source for the summary —
`Cloned 2157/2157 files (2.00 GiB/2.00 GiB)` and `Clone complete in 141.37s`. Never build that
summary from React state captured before the run; that reported zeroes beside a console showing
the real totals.

### Three auth failures that look alike and need opposite fixes

| lore says | Means | Fix |
|---|---|---|
| `Unauthenticated`, `token expired` | the session died | sign in again |
| `Not authorized to access repository` | signed in, no grant | ask the host — **and refresh**, see below |
| `No token stored` | the identity *this repo pins* is signed out | sign in as that user |

**A refusal caches.** A grant added on the host does nothing until the cached authorization token
expires (`AUTHZ_TTL`, 15 minutes) or is cleared — observed with the grant in the database while
every retry still failed and the identity service logged no request at all. `auth_refresh_access`
clears it, and **strips `urc-`**: the store keys the resource by its bare id, so
`lore auth logout --resource urc-<id>` reports "Logged out" and removes nothing.

### Repository discovery needed a new RPC on the host

`lore repository list` failed with `LookupUserPermissions is unimplemented`. Implemented in
[alt-p2p-lore-identity](https://github.com/sync-different/alt-p2p-lore-identity) and deployed to
ctone 2026-08-13. Two things only the live service could teach: the CLI sends
`resource_filter="urc"` — the resource **type**, not an id or wildcard — and the output is
`name (id)` per line, which is what lets the UI show names only. Listing answers from the
caller's own grants, never the resource table, so it cannot be used to discover what exists.

### Shared store: measured, not assumed

`--use-shared-store` saved **13 MB and no time** on a 2 GiB repository (141s vs 138s, 2064 MB vs
2050 MB). The bulk is the materialised working tree, written in full every time. Keep the option;
do not promise a speed-up.

### Tunnels are Rust-owned, and must be reaped

The registry outlives the UI, so **every spawned process must be killed on exit** —
`kill_all` on both `ExitRequested` *and* `Exit`, plus `orphans.rs`, which records pids and reaps
them at next launch. The pid file is **not trusted**: a candidate's command line is checked before
signalling, because pids are reused and killing a stranger is worse than the bug being fixed.

Two processes on one alt-p2p session id is never legitimate — the session id *is* the rendezvous
name, and a REGISTER on an already-paired session recycles the coordinator's slots. `start_tunnel`
kills a stuck attempt before spawning and reuses a live one.

### Testing traps met here

- **A count of one is not a proof of one.** Every cardinality bug looked correct with one host,
  one identity, one clone. Test the plural case.
- `listen()` is asynchronous: an effect that re-runs drops events in the gap. Hold callbacks in a
  ref so subscribing never depends on their identity.
- Under vitest, **`mockReset`/`mockClear` between tests makes a *handled* throw surface as an
  unhandled runner error**. Set implementations per test instead.
- Fixtures live in `src-tauri/tests/fixtures/`, captured from the real CLI. Regenerate rather than
  hand-edit; a fixture that never existed proves nothing.

## Development Status

M1 (shell), M2 (read-only repository browsing) and M3.1–M3.6 are done: tunnels, hosts and
workspaces, sign-in with a pasted token, expiry warnings, repository discovery, and clone with a
live progress bar. Next: commit, sync/push, branch switch, locks (M3.7–3.10), then reconnect and
an end-to-end pass.

Deferred and known: the app knows nothing about **links**, which cross access boundaries — a
`Not authorized` naming an unfamiliar resource id will be one, and ARCHITECTURE.md says why.
