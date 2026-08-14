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
./scripts/fetch-deps.sh      # stage lore, run-java, the jar and a jlink JRE (never committed)
npm install
npm run tauri dev            # development
npm run tauri build          # bundles for whatever host you are on

npm test -- --run            # vitest (frontend)
cd src-tauri && cargo test   # Rust
```

Runs on macOS and Windows. Two things about the order that are not obvious:

- **`fetch-deps.sh` comes first, always** — including before `cargo test`. `tauri-build`
  validates `externalBin` and `resources` before compiling any Rust, so with an unstaged
  payload the *tests* fail, not just the build, and the message names a file rather than the
  cause.
- **On Windows, stop `tauri dev` before `cargo test`.** Windows locks the running `.exe`
  against relinking and the build dies on `Access is denied. (os error 13/5)`. The two coexist
  happily on macOS, so the habit does not transfer.

Windows additionally needs the MSVC toolchain and Git Bash (which runs `fetch-deps.sh`
unchanged). See **[Building on Windows](#building-on-windows)**.

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
- **A test that writes and reads through the same constant proves nothing.** The first version of
  the `lore.exe` lookup test created a file named `LORE_EXE` and asserted `LORE_EXE` was found —
  true however wrong that constant was, and it passed against the very bug it was written for.
  Only spelling the expected name out independently made it fail. When a test and the code under
  it agree by construction, the test is a mirror.
- **A hang is not a failure until you give it a deadline.** The ConPTY bug made `pump_pty` block
  forever; a test calling it directly would have hung the runner and reported nothing. Run it on
  a thread with `recv_timeout` so "never returned" becomes an assertion with a message.
- **Confirm the fix by re-running the experiment that found the bug, not a new one.** The
  orphaned-JVM test looked *fixed* on the first attempt while still broken — the JVM had exited
  on its own because its connect failed, not because anything killed it. The observation was
  real and the inference was wrong. Control for why the thing you are watching might do the right
  thing for the wrong reason.
- **The compiler had been reporting one of these bugs all along.** `parse_duration` was called
  and its result dropped, so the clone summary never showed a duration — an `unused variable:
  seconds` warning that had become scenery. Warnings in a tree that otherwise has none are worth
  reading.
- **Verify you launched what you just built.** A successful `npm run tauri build` is not evidence:
  the product was renamed, so yesterday's `Alterante Lore.app` sat beside today's `alt-lore
  Desktop.app` and sorted *first* — `ls | head -1` launched a stale bundle that looked identical.
  Compare the bundle binary's mtime against the build, not the build log against a success line.
  (Two rounds of "still yellow" were spent on the same shape of mistake earlier.)

## Building on Windows

This repository now has a remote (`sync-different/alt-p2p-lore-ui`), added to get it onto a
second machine. Note that a clone does **not** bring `internal/` (git-ignored plans) — copy that
across separately, or work without it; nothing in the build depends on it.

**Windows builds and runs.** `msi` and `nsis` bundles, and both suites green — **225 Rust, 353
vitest**. The port itself changed no test and no parser: it reached macOS's 219 and 353 on the
Cargo.toml fix alone, and the six extra Rust tests came later, with the bugs found by *running*
the thing. What follows replaces the earlier list of predictions; where a prediction was wrong,
the correction is the interesting part.

The order they are actually met is not the order they were guessed:

| | |
|---|---|
| **1. staging, not keyring** | `tauri-build` validates `externalBin` *and* `resources` before compiling a line of Rust, so **`cargo test` cannot run at all** until `lore`, `run-java`, the jar and a JRE are on disk. On Windows the tests are gated behind the full third-party payload. |
| **2. `src-tauri/Cargo.toml`** | The problem was the *section*, not the feature. All four crates sat under `[target.'cfg(unix)'.dependencies]`, but only `libc` is Unix-only — `tokio`, `dirs` and `keyring` are called from code with no `cfg` on it, so Windows lost three crates and 16 errors. `keyring` is now split per `target_os` (`apple-native` / `windows-native` / `linux-native`); it offers no portable default, and naming one platform's backend is exactly what pinned the crate to that platform. |
| **3. `run-java` was never staged at all** | Not by `fetch-deps.sh`, on either platform — it had been copied into `binaries/` by hand, and nothing recorded it. A fresh clone bundled everything except the wrapper that starts the tunnel, and Tauri said only "binary not found". The script stages it now. |
| **4. a shell script cannot be a Windows sidecar** | It must be a real PE image; a renamed `.cmd` will not load. `src-tauri/scripts/run-java.rs` is the counterpart to `run-java.sh`, compiled by `fetch-deps.sh` with plain `rustc` — already required for the triple, so it adds no prerequisite. Same sidecar name on both platforms, so `supervisor.rs` and `prereq.rs` never learn which OS they are on. |
| **5. `tauri.conf.json`** | `"targets": "all"` rather than a platform list — it is Tauri's own default and resolves per host. This is what the sibling **alt-p2p-ui** already ships on Windows. |

`fetch-deps.sh` runs **under Git Bash unchanged** — bash and `file` are both there, so it stayed
one script rather than two that drift. What genuinely differed: the `.exe` suffix, `lore` at
`~/bin/lore.exe`, `JAVA_HOME` instead of `/usr/libexec/java_home`, and `file -b` spelling the
architecture `x86-64` for PE where Mach-O says `x86_64` — which silently emptied a manifest field
that exists to answer "what went into this build?".

**When in doubt, read [alt-p2p-ui](https://github.com/sync-different/alt-p2p-ui).** It is the same
stack — Tauri, a Java sidecar, a jlink'd JRE — already shipping on Windows, and it settled the
sidecar shape and the bundle targets here. Its `src-tauri/sidecar/src/main.rs` is the proven
version of `run-java.rs`, including the `resources/jre` fallback layout.

Prerequisites beyond the macOS list: **MSVC toolchain** and VS Build Tools with "Desktop
development with C++". `wmic` is **gone** from Windows 11 — anything reaching for it needs
`Get-CimInstance Win32_Process` instead.

**`cargo test` cannot run while `tauri dev` is running.** Windows locks a running `.exe`
against relinking, so the build dies on `failed to remove file … Access is denied. (os error 5)`
— which names a file, not the cause. Stop the app first. On macOS the same two commands
coexist happily, so the habit does not transfer.

**Clone resolves `lore` by hand, and that is the only call that does.** Everything else goes
through the shell plugin's `sidecar("lore")`, which appends `.exe` itself; the pseudo-terminal
needs a real path, so `clone.rs` looks the binary up directly and had the Unix name hardcoded.
The symptom is worth remembering because it points nowhere near the cause: the host dot green,
every other command working, and **Clone alone** reporting "The bundled Lore program could not
be found next to the app" — while it sat right beside the app under a name with four more
characters. It is the **only** such call — checked: `current_exe` appears nowhere else, and
every other invocation goes through `sidecar()` or, for the jar and manifest, `resolve()`.

Two predictions that were checked and found harmless: **CRLF** (Git Bash runs `.sh` with CRLF
correctly, heredocs included, so no `.gitattributes` is needed), and the **jlink read-only**
workaround, which costs nothing on Windows.

Staging the third-party payload, as it actually went:

- **`lore`** — EpicGames ship a PowerShell installer (`scripts/install.ps1`; the shell one refuses
  to run on Windows). Pin the version and match the hosts — 0.8.6 here, `lore.exe` and
  `loreserver.exe` landing in `~/bin`, which is why `LORE_SRC` defaults there on Windows.
- **the jar** — platform-independent, but **built from a chain**: `alt-p2p-lore` depends on a
  matching `alt-p2p`, which must be `mvn install`ed first or the build fails on an unresolvable
  `com.alterante:alt-p2p`. The version is not pinned in `fetch-deps.sh` any more — it takes the
  newest jar in `target/`, because a pinned name had already gone stale against a version that no
  longer existed.
- **the JRE** — `jlink` from any JDK 17+ (26 was used, and the jar runs fine on it). The
  read-only-output workaround costs nothing here: `chmod` is a no-op on Windows and the rebuild
  problem it exists for does not arise.

Of the two behaviours to distrust, one is settled and one is still open:

- **Path separators agree. Nothing needed changing.** `lore` 0.8.6+373 prints repository paths
  with **forward slashes** on Windows (`M StackOBot/Intermediate/CachedAssetRegistryDiscovery.bin`),
  and `list_dir` builds `rel_path` with an explicit `format!("{rel}/{name}")`. Both sides speak
  `/`, and a forward-slash path handed *back* to `lore diff` is accepted. Non-zero exits survive
  too, so `cmd.rs`'s "non-zero is an `Err`" holds.
  The trap: `lore` **does** print backslashes on Windows — in its own Rust source locations inside
  error traces (`at lore-storage\src\error.rs:31:9`), never in repository paths. Grepping the
  output for `\` raises a false alarm.
- **ConPTY reads fine and never ends.** The `\r` split works, every line parsed, the bar and
  both summary lines arrived — and the clone hung anyway. Reading to EOF is enough on Unix,
  where the last slave descriptor closing ends the stream; **conhost keeps the master readable
  after the child exits**, so the read blocked forever, the sender was never dropped, the
  `rx.recv()` loop never ended, and `done` was never emitted. A clone that finished in 0.08s
  left the button saying "Cloning…".
  The fix is to wait on the child separately and *close the master*, which is what actually
  ends the read — with a short drain first, because the last thing `lore clone` prints is
  exactly the summary the totals are parsed from. `pump_pty` is split out from `clone_repo`
  so this is testable against `cmd /c echo` with no host, no repository and no `lore`; the
  tests assert with a **deadline**, since the failure is a hang, and a test that hangs reports
  nothing.
  ConPTY also opens with a sequence no Unix pty sends — `[?9001h[?1004h[?25l[2J[m[H` plus an
  OSC title — which `without_ansi` already drops.

### A tunnel outlived the app on Windows — fixed with a job object

Windows does not kill children with their parent, and the pid Tauri hands the registry is the
**wrapper's**, not the JVM's. So `CommandChild::kill` terminated `run-java.exe` and left the JVM
running — holding 41400 and its coordinator session, through `kill_all` on exit, through
Disconnect, through everything. Hit twice in one session; the second time the next connect was
refused for a port nothing appeared to be using.

`orphans.rs` could not save it: its markers matched the leaked command line perfectly
(`jar=True connect=True`), but `command_of` returns `None` under `cfg(not(unix))`, so reaping is
a **silent no-op** on Windows whose tests pass trivially. The recognition is right; it never runs.
That remains true — the reaper is still a no-op here, and is now genuinely a safety net rather
than the mechanism.

The fix is in `scripts/run-java.rs`: the wrapper puts the JVM in a **job object with
`KILL_ON_JOB_CLOSE`**. The handle is deliberately never closed, so the only thing that closes it
is the wrapper ending — however it ends, `TerminateProcess` and crashes included — and Windows
then kills the job. One mechanism covering all three `child.kill()` sites plus the crash case.

Proved by the experiment that found the bug, run again: a deliberately long-lived JVM, parent
killed, child checked three seconds later. **Before: parent dead, JVM alive. After: both dead.**
Note the first version of that experiment was confounded — the JVM had exited on its own because
the connect failed — so it must be run with a JVM that would otherwise stay up.

alt-p2p-ui does not solve this and is not a guide here: one `.kill()`, no job object, no reaper.
Its JVM is short-lived per transfer, so the leak never shows. A tunnel that runs for hours does.

### A tunnel can die upstream and still look alive

Observed: every request hanging, the dot green, ports bound. The tunnel JVM was alive with **0
CPU and no socket to the relay at all** — only the local client connected to 41400. `lore` connects
to a listening port and waits forever. Confirmed as transport rather than app by running
`repository list` through the same tunnel: the call that had returned instantly also hung.

Two separate gaps, and the important one is not in this app:

- **The jar does not notice.** `ConnectCommand` blocks on `mux.awaitClosed()` (relay) or
  `pc.awaitDisconnect()` (direct), then emits `{"event":"disconnected"}` and exits 0. Here the
  relay socket was gone and `awaitClosed()` never returned — so no event, no exit, no signal of
  any kind. Nothing the app can subscribe to. **This is an alt-p2p-lore bug**, in the relay mux.
- **The app would not have parsed it anyway.** `TunnelEvent` covers `status`, `tunnel_ready` and
  `error`; `disconnected` is a *distinct event kind*, not a state, so it lands in
  `#[serde(other)] Unknown`. Mostly harmless — the jar exits straight afterwards and the exit is
  what the supervisor reacts to — but it means the event carries no weight of its own. Note
  `TunnelPhase` has no `Disconnected` either, and `Other` is documented as "shown as progress".

So the reconnect logic never fired, correctly: its trigger is an exit or a failure event, and
neither happened. This is a *third* kind of host failure, distinct from the two M3.11 was built
from — a sleeping host and a restarted one both ended the connection observably. Detecting it
needs a probe that goes **through** the tunnel rather than one that checks the local port is
bound. Note the direct-host probe shares the blind spot in principle: a TCP connect to a
forwarded port proves the forwarder is up and nothing beyond it.

**Test hosts** (local test infrastructure; **no secrets in this repo** — session keys live in the
OS keychain, and coordinator details are in the app's host settings):

- a **direct** LAN host: Fedora, open `loreserver` on `41337` (tcp *and* udp — QUIC shares the
  number), **no authentication**. Needs no local ports at all, which makes it the easiest thing
  to point a fresh build at. Its address is in the app's host settings, not here.
- a **P2P** host reached through a coordinator, with an identity provider — that one exercises
  sign-in, and its identity port must match the host's exactly.

The direct host is the better first target on a new platform, and that held: it needs no tunnel,
no keychain and no identity, so it had clone, commit and push working while the P2P side was
still being untangled.

### A new machine needs three things that live nowhere in git

Every P2P failure on this pass was one of these, and none is a code problem — they are simply
state that does not travel with a repository or a config, and each fails with an error pointing
somewhere else:

| Missing | How it presents |
|---|---|
| **The identity port** on the host entry (9443 — the `auth_url` loreserver publishes, so not a free choice) | `Not authenticated`. With `identity_port` null, `hostAuthUrl` returns `null`, the app concludes the host needs no sign-in and **never offers one** — so the thing to change is a blank field in a form, and nothing says so. |
| **A sign-in** for that auth URL | `Not authenticated` again. Identities live in `lore`'s own store, per auth URL, machine-wide; none of the other machine's sign-ins come across. |
| **The CA** in the OS trust store | `authorization header required`, then `Repository not found` — a *missing grant*'s error, with the grant plainly present. `--log-level debug` names the real cause on one line: `Auth exchange failed … failed to connect to auth endpoint: transport error`. |

The last one is worth dwelling on, because everything visible said the network was fine: TLS 1.3
completed, ALPN negotiated `h2`, the tunnel forwarded 9443, and `lore repository list` answered
through it. The service presents a leaf signed by a private CA and sends no issuer, so
verification failed and no `authorization` header was attached. `tls-native-roots` means the OS
trust store is the fix — `Import-Certificate -CertStoreLocation Cert:\CurrentUser\Root` is enough,
and the app's child processes inherit it. Verify the CA against the live endpoint
(`openssl s_client -CAfile …` → `Verify return code: 0`) before installing it, rather than
trusting a certificate because its CN looks familiar.

**A method note, since two diagnoses here went wrong before they went right.** Both times the
fix came from running the failing command *outside the app* — bare `lore clone` reproduced the
authorization failure exactly, which ruled out the entire UI in one step, and `lore repository
list` through a hung tunnel proved the transport was dead rather than the clone. When something
fails in the app, the cheapest next move is to run what the app runs. The traces name the command
for precisely this reason.

Equally: `curl` reporting `Empty reply from server` against the identity service was **not**
evidence of a fault — it is an h2-only endpoint and that curl offered HTTP/1.1. I mistook it for
a symptom, then over-corrected and called my own correct reading wrong. The signal was
`Verify return code: 21`, visible only once the probe spoke the right protocol. Probe with a tool
that speaks what the server speaks, or the result means nothing either way.

## Development Status

M1 (shell), M2 (read-only repository browsing) and M3.1–M3.11 are done: tunnels, hosts and
workspaces, sign-in with a pasted token, expiry warnings, repository discovery, clone with a live
progress bar, commit, sync/push and merge conflicts, branch switch and create, locks — taking,
releasing, and breaking someone else's with a confirmation that names them — and hosts that come
and go.

**M3.12 (end-to-end pass): done on Windows, and the app now builds and runs on both platforms.**
Parsers were re-verified against live 0.8.6 output and the branch-standing fixture gap closed;
the manual pass was then driven against both host kinds on Windows — a direct LAN host and a P2P
host through the TCP relay. Exercised against live hosts, not only fixtures: tunnel, sign-in,
repository discovery, a 2.1 GiB clone, commit and push (landed on the host as revision 23,
attributed correctly), locks taken and released with a second identity's lock present and left
alone, and orphan cleanup on disconnect.

Still unexercised on Windows: **branch switch/create**, and quitting the app with a tunnel
connected. Both work on macOS; neither has been watched here.

Deferred and known:

- the app knows nothing about **links**, which cross access boundaries — a `Not authorized`
  naming an unfamiliar resource id will be one, and ARCHITECTURE.md says why.
- **`orphans.rs` does nothing on Windows.** `command_of` returns `None` under `cfg(not(unix))`,
  so the reaper is a no-op whose tests pass trivially. The job object in `run-java.rs` now covers
  the case it existed for, which makes this a missing safety net rather than a live bug — but a
  JVM left by a build predating the job object will not be reaped. A Windows implementation wants
  `Get-CimInstance Win32_Process` (`wmic` is gone from Windows 11), batched into **one** call:
  `reap` runs synchronously in `setup()` before the window appears, and a PowerShell start costs
  ~1.7s.
- **Two faults found on this pass belong to other repositories**, not here. The relay mux does not
  notice its own connection dying (alt-p2p-lore), and something on ctone produced 28,290 broken
  HTTP/2 streams during a single clone that nevertheless completed. Both are described under
  "A tunnel can die upstream and still look alive".
