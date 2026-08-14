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

### Locks are advisory, and the CLI enforces nothing

Established against a live host with two identities, because every one of these is the opposite of
what the operation's name implies:

- **Anyone can release anyone's lock, and `--force` is not required.** `uitest` released a lock held
  by `ale` and the CLI simply reported `Lock released on files:`. There is no ownership check to
  lean on — the entire guard against handing a colleague's work away is `BreakLockDialog`, so the
  split between "Unlock" (ours) and "Break lock" (theirs) exists only in this app. `--force` is
  passed on a break anyway, to record the intent at the point the process is spawned.
- **The printed owner is a display string, not an identity.** One lock, unchanged on the host, has
  been observed rendering three ways: `Alejandro` in the workspace holding it, `ale` in another
  workspace on the same machine, and later the raw `u-87c4b8c8b7f44fc1`. Never compare it to decide
  ownership. `lock query --owner` is resolved server-side and accepts id, username or display name,
  so ownership is a **second query**, and `FileLock.mine` is `Option<bool>` — unknown stays unknown,
  and unknown is treated as *someone else's*.
- **A refused acquire names neither the file nor the holder** — the whole output is `Failed to
  lock-acquire 1 batch(es) out of 1` plus a source location. `acquire_locks` therefore re-queries on
  failure and returns holders as `blocked`. Conditional, like every other translation here: unless a
  requested path is independently found to be held, the original error stands, or an offline host
  would be reported as a colleague's lock.
- Re-taking your own lock reports `Lock already owned on files:` — a success that changed nothing,
  and reported separately so the UI does not claim to have locked what was already yours.
- `status --scan` says nothing about locks; they are always a separate read, and one that needs a
  live host. Offline is `Unable to check lock status while offline` → **unknown, never "unlocked"**.
- **`repoIdentityRef` is a sentence, not an id.** It holds `nameForId`'s output —
  `"uitest (u-99f5f8484b0a47fd)"` — because it exists to be read in an error message about a
  sign-in. Sent as `--owner` it matches no account, so every lock the user held came back
  unattributed and was rendered as a colleague's, complete with an offer to break it. Ownership
  reads `info.identity`, the raw id from `.lore/config.toml`, which is also correct the instant
  `info` exists rather than after an effect has run. Same lesson as the owner string one row up,
  and it caught me anyway: a display string and an identifier must never share a channel.

### The console, and why traces are always recorded

The bottom panel merges two streams: the app's own notices, and one line per `lore` process
the backend spawns (`lore://command`, emitted from `cmd::run`).

- **Traces are emitted and kept whether or not debug is on.** A diagnostic that only helps
  people who switched it on *before* things went wrong is not much of a diagnostic; the setting
  gates display, not recording. Volume is a handful of events per user action, capped at 500.
- **Redaction happens in Rust, at the point of formatting**, and these strings are now shown on
  screen rather than only logged — so `redact()` also hides anything *shaped* like a JWT,
  wherever it appears. Flag-position matching alone would miss a credential passed positionally
  or behind a flag added later. The shape test is narrow on purpose: a false positive turns a
  path into `***`, a false negative prints somebody's bearer token.
- **A failed command shows under Problems** even though the trace stream is otherwise dim — it
  is a problem, and it is what someone filtering for problems is hunting.
- The panel is **across the bottom, not down the side**: its lines are long (a command with
  paths and flags), and a 288px column wrapped every one into four fragments. It replaced the
  `Activity` pane; that component's tests were ported to `Console.test.tsx` rather than deleted,
  since they pin the session-labelling fix.

### Hosts come and go, and that is not an error

M3.11, written from two real failures rather than from imagination: a host that went to sleep
mid-session, and one restarted underneath a push.

- **One read at a time.** Window focus, the refresh button and the end of every write all
  trigger a re-read, so overlap is ordinary — and against an unresponsive host their deadlines
  simply add up. Observed: `lore status --scan` at 22.4s, 19.2s and 10.3s in a row. A refresh
  arriving during one now queues a single follow-up, which never announces itself.
- **Reads have their own deadlines.** `INTERACTIVE_TIMEOUT` 20s, `HOST_READ_TIMEOUT` 10s, against
  the 120s default that is sized for transfers. Locks match what `lore` itself does — it gives up
  at ~10s — so a longer wait would only add silence after the CLI had already decided.
- **A direct host is probed, never assumed.** It has no process to watch, and the dot was
  hardcoded green: a switched-off machine looked exactly like a serving one. A TCP connect
  every 15s and on focus. `refused` (0.2s) and `unreachable` are kept apart because they send
  you to different places — start the service, or go and look at the machine.
- **Reads and transport recover automatically; writes never do.** A host that returns re-reads
  status and locks, and a dead tunnel is put back up (3 widening attempts, then it says so).
  A push that failed is *raised* when the host comes back, with a button — never re-sent. The
  difference between "your work is waiting" and "your work has just gone out" is something a
  person needs to have chosen.
- **`lore status --scan` succeeds with the host down**, omitting the remote lines rather than
  failing. The standing falls to `Unknown`, which already refuses to push — but note that the
  app learns a host is unreachable from a *missing line*, not from an exit code.

### Two findings from the end-to-end pass

- **Five standings, two fixtures.** `parse_status` can produce Unknown / InSync / Ahead / Behind /
  Diverged, and only the first two had a captured example — the three missing ones are exactly
  those that decide whether Push and Sync are offered. They were captured by driving two clones of
  a scratch repository into each state against the LAN host. The parser was already right, but
  "right" had been an assumption. A test now asserts every variant has a fixture, so a new one
  cannot arrive as dead code that looks tested.
- **A comment claimed an invariant the code never held.** `lib/repo.ts` said everything that knows
  about `invoke` lives there; eight components and hooks call it directly. Narrowed to what is
  true (repository commands are wrapped; single-command dialogs invoke directly and are tested by
  mocking the module). A tidy rule contradicted in eight places is worse than an honest narrow one,
  because the next person believes it.

### Testing traps met here

- **A count of one is not a proof of one.** Every cardinality bug looked correct with one host,
  one identity, one clone. Test the plural case.
- `listen()` is asynchronous: an effect that re-runs drops events in the gap. Hold callbacks in a
  ref so subscribing never depends on their identity.
- Under vitest, **`mockReset`/`mockClear` between tests makes a *handled* throw surface as an
  unhandled runner error**. Set implementations per test instead.
- Fixtures live in `src-tauri/tests/fixtures/`, captured from the real CLI. Regenerate rather than
  hand-edit; a fixture that never existed proves nothing.
- **A tested policy is not a wired policy.** The reconnect decision had six tests and worked
  perfectly; the one line that *called* it failed to be inserted by an edit, so a killed tunnel
  went red and sat there. Every test still passed, because they all exercised the function in
  isolation. Where a decision is reached through an event, test the path from the event.
- **Verify you launched what you just built.** A successful `npm run tauri build` is not evidence:
  the product was renamed, so yesterday's `Alterante Lore.app` sat beside today's `alt-lore
  Desktop.app` and sorted *first* — `ls | head -1` launched a stale bundle that looked identical.
  Compare the bundle binary's mtime against the build, not the build log against a success line.
  (Two rounds of "still yellow" were spent on the same shape of mistake earlier.)

## Building on Windows

**This repository has no git remote** (`git remote -v` is empty) — it has only ever existed on
one machine. To get it onto another, either add a remote and push, or copy the folder. Copying
brings `internal/` (git-ignored plans) with it, which a clone would not.

**Nothing here has ever been built or run on Windows.** Everything below is what a reading of
the tree says will break, not experience — treat it as a starting list rather than a finished
one, and correct it once you know better.

Four things will stop a Windows build, in the order you will meet them:

| | |
|---|---|
| `src-tauri/Cargo.toml` | `keyring = { features = ["apple-native"] }` — macOS-only. Windows needs `windows-native`. This is where **session keys** live, so it is not optional. |
| `src-tauri/tauri.conf.json` | `"targets": ["app", "dmg"]` are macOS bundles. Use `msi` and/or `nsis`. |
| `scripts/fetch-deps.sh` | stages the sidecar as `binaries/lore-<triple>` with no **`.exe`**. Tauri looks for `lore-<triple>.exe` on Windows and the failure says only "binary not found". |
| the script itself | bash, and it shells out to `file -b`. Run it under Git Bash, or port it. The **triple is derived from `rustc`**, so that part is already portable. |

Staging the third-party payload:

- **`lore`** — EpicGames ship a PowerShell installer (`scripts/install.ps1`, the shell one refuses
  to run on Windows). Pin the version: `-Version v0.8.6` and match whatever the hosts run. The
  shell installer also needs `--server` to place `loreserver`; assume the same split.
- **the jar** — platform-independent, built from `alt-p2p-lore` with `mvn package`.
- **the JRE** — `jlink` from a Windows JDK 17+. The script's read-only-output workaround is
  written for a Unix `chmod`; expect to adjust it.

Two behaviours to distrust until you have watched them:

- **`lore clone` is driven through a pseudo-terminal** (`portable-pty`) because the progress bar
  only draws for an interactive terminal. On Windows that is ConPTY, and the parser splits on
  `\r` *as well as* `\n` — which matters more there, not less.
- **Path separators.** The app builds its own relative paths with `/`, and every parser was
  written against macOS output. If `lore` prints `\` on Windows, the tree and the change list
  will disagree about what a path is. Check this early; it is the kind of thing that half-works.

**Test hosts** (local test infrastructure; **no secrets in this repo** — session keys live in the
OS keychain, and coordinator details are in the app's host settings):

- a **direct** LAN host: Fedora, open `loreserver` on `41337` (tcp *and* udp — QUIC shares the
  number), **no authentication**. Needs no local ports at all, which makes it the easiest thing
  to point a fresh build at. Its address is in the app's host settings, not here.
- a **P2P** host reached through a coordinator, with an identity provider — that one exercises
  sign-in, and its identity port must match the host's exactly.

The direct host is the better first target on a new platform: no tunnel, no keychain, no identity.
If the keyring change is not done yet, a direct host with a blank auth URL still gets you clone,
commit, push, sync and locks.

## Development Status

M1 (shell), M2 (read-only repository browsing) and M3.1–M3.11 are done: tunnels, hosts and
workspaces, sign-in with a pasted token, expiry warnings, repository discovery, clone with a live
progress bar, commit, sync/push and merge conflicts, branch switch and create, locks — taking,
releasing, and breaking someone else's with a confirmation that names them — and hosts that come
and go. M3.12 (end-to-end pass) is under way: parsers re-verified against live 0.8.6 output, and
the branch-standing fixture gap below closed. What remains is a manual pass through the UI across
both a P2P host and a direct one.

Deferred and known: the app knows nothing about **links**, which cross access boundaries — a
`Not authorized` naming an unfamiliar resource id will be one, and ARCHITECTURE.md says why.
