# Architecture

How alt-lore Desktop is put together, and why. For what the app *does*, see the README; for how
to work on it, see [CLAUDE.md](CLAUDE.md).

## The shape of the problem

The app owns almost nothing. It orchestrates two programs that already exist:

- **`lore`** — the Lore CLI. Short-lived invocations, plain text output, no machine-readable
  mode. Every answer must be parsed from what a human was meant to read.
- **`alt-p2p-lore connect`** — a long-lived tunnel process that makes a remote host's
  loreserver and identity service appear at loopback addresses on this machine.

Those two facts drive most of the design. One is a *question and answer*; the other is a
*process that must outlive every screen*.

The tunnel is **transport, not structure**. A host can equally be reached directly at an
address — a machine on the network, or this one — and past that point nothing differs: the
same cloning, the same sign-in, the same reasoning about which workspace belongs where.

Which transport is not only a question of reachability. Cloning the same 2 GiB repository from
the same machine on the same LAN took **16s direct (118 MB/s)** against **100s through the
tunnel (19 MB/s)**. The tunnel is not slow — that is above alt-p2p's own documented localhost
figure, and it is carrying DTLS and its own reliability layer over UDP — but where a direct
route exists it is worth roughly six times the throughput. P2P earns its cost when there is no
route at all, which is most of the time and not all of it.

```
┌── webview (React) ───────────────────────────────────────┐
│  components: dumb                                        │
│  hooks: subscribe, poll, hold no truth                   │
│  lib: pure decisions — parsing, health, cardinality       │
└──────────────┬───────────────────────────────────────────┘
               │  Tauri commands (request/response)
               │  Tauri events (tunnel://update, clone://progress)
┌──────────────┴───────────────────────────────────────────┐
│ Rust                                                      │
│  registry   long-lived tunnel processes  ← the only truth │
│  session    hosts on disk, keys in the OS keychain        │
│  workspace  working copies, summarised without running     │
│  lore/*     invoke the CLI; parse; redact                 │
│  orphans    reap what a previous run left behind          │
└──────────────┬───────────────────────────────────────────┘
               │ spawn
        ┌──────┴───────┐
     `lore`       `alt-p2p-lore connect`
   (short-lived)   (hours; owns loopback ports)
```

## Where state lives, and why there

| State | Lives in | Reason |
|---|---|---|
| Running tunnels | Rust `registry` | A process must outlive the component that started it. The frontend holds ids; Rust holds handles. Every spawn is killed on exit, and `orphans.rs` reaps what a crash left behind. |
| Hosts (how to reach them) | `sessions.json` | Plain, user-editable, no secrets. A host is a URL plus, for P2P, what is needed to build the tunnel that serves it. |
| Session keys | OS keychain | A key in a settings file is a key in a backup. |
| Workspaces | `workspaces.json` | A list of paths; everything else about a working copy is read from the working copy. |
| What a repository *is* | The repository | Its host, its identity, its branch and its ids all live in `.lore/`. The app reads them; it never keeps a second copy to drift. |
| Identities and tokens | `lore`'s own store | The CLI owns credentials. Holding a copy would add a place to leak from without being the one anything reads. |

The rule behind the last three rows: **the app remembers where to look, not what it found.**
Anything cached about a repository or an identity would be a second answer to a question that
already has one, and the two would disagree exactly when it mattered.

## Domain constraints the design is built around

These come from Lore and alt-p2p, not from this app, and they are the reason for several
otherwise-odd choices. Each was verified against a live host.

1. **A working copy reaches its host by URL** — `remote_url` in its own config, not by
   "session". Whichever host serves that URL serves it, whatever the UI is showing. For a
   tunnelled host the URL is a loopback address; for a direct one it names the machine.
2. **A working copy may pin the identity it acts as.** That, and not signing in and out, is what
   lets one person hold two clones of one repository as two different users.
3. **Identities are stored per auth URL for the whole machine**, and signing in *adds* to them.
   So sign-out is a machine-wide act, and "which user am I?" is only answerable per host —
   which is why identities are keyed by auth URL here too, exactly as `lore` keys them.
4. **One tunnel per host.** The identity port binds once, so two configured P2P sessions to one
   host can never both be connected. A direct host has no such limit — there is nothing to
   bind.
5. **A lock is shared state, and nothing enforces who owns it.** Releasing another person's lock
   succeeds, without `--force`. The owner as printed is a display name that renders differently
   depending on which workspace asks, so ownership is resolved by the server rather than compared
   locally — and where it cannot be established it stays *unknown*, which is treated as somebody
   else's.

Consequently:

- **Hosts and workspaces are separate concepts with separate UI.** A tab is a workspace — a
  working copy plus its identity — because nothing about repository work is per-connection.
- **A workspace's host is derived, never stored.** It is whichever host serves the URL the
  repository dials, compared on `host:port` — the two URLs are written by different programs
  and differ in trailing slashes and paths, never in the authority. There is no link to keep
  in step.
- **A host is a URL, and transport is a property of it.** P2P derives its URL from the port
  the tunnel forwards; a direct host is given one. Keying on the port alone made any two hosts
  on that port the same host, which is true only while everything is a tunnel.
- **Anything spanning hosts must name its host.** With two connected, "signed in as…" is
  ambiguous unless it says whose store it means.

## Talking to `lore`

Every call goes through `lore::cmd::run`: one place for the sidecar, the timeout, and
`redact()`, which hides anything following a credential-bearing flag wherever arguments are
logged. A non-zero exit is an `Err`, so no caller can mistake an error message for data.

**Parsers are pure and fixture-backed.** `lore` has no machine-readable output, so each parser
is tested against text captured from the real CLI in `src-tauri/tests/fixtures/`. Parsing is
kept separate from invocation for exactly this reason: the interesting failures are in reading,
and they can then be tested without a host, a tunnel or a repository.

**Errors are translated, not relayed.** The CLI reports causes several layers from the fix — an
expired token as a storage error, a missing grant as "Not found", an unserved address as
"Disconnected from server". Each translation is narrow and conditional: it only fires when the
app independently knows the precondition holds, because a confident wrong explanation sends
someone to change the one thing that was already right. The original text is always kept.

**One call needs a terminal.** `lore clone` draws its progress bar only for an interactive
terminal, so clones are spawned through a pseudo-terminal and the bar is parsed. It is the only
place the app fakes being a person.

## Talking to the tunnel

`alt-p2p-lore connect --json` emits NDJSON. The supervisor spawns it, parses events, updates the
registry, and forwards a typed update to the webview on `tunnel://update`.

Updates carry a **kind** (`status`, `ready`, `failed`, `exited`) as well as a phase, because two
different events legitimately report "connected" — the peer link coming up, and the local port
becoming usable — and only one of them is worth announcing.

An exit the app asked for is not a failure. A killed child exits exactly like a crashed one, so
the registry records the intent before killing; without that, disconnecting looks like an error.

## The webview

React holds no truth. Hooks mirror Rust state and poll what cannot be pushed; components render
what they are given. The decisions live in `src/lib/` as pure functions — reachability, workspace
health, expiry classification, progress arithmetic, label disambiguation — which is what makes
them testable without a browser, a tunnel or a host, and where most of the test suite is.

Event subscriptions are held by reference rather than by dependency, so a caller passing a fresh
callback cannot silently unsubscribe: `listen()` is asynchronous, and an effect that re-runs
drops whatever arrives in the gap.

## Security posture

- The shell plugin is registered for **Rust only** and is absent from the webview's capabilities.
  Argument vectors are built in the backend; user input never becomes a command line by accident.
- Secrets live in the OS keychain and are redacted wherever arguments are recorded.
- Pasted tokens are handed to `lore` and not retained.
- The reaper checks a process's command line before signalling it, because pids are reused and
  killing a stranger is worse than the leak it prevents.

## What the app deliberately does not know

- **Links.** A repository's revisions can reference other repositories, each with its own access
  boundary and grants. An authorization error can therefore name a repository the user never
  opened. Nothing here models that yet.
- **Views and layers.** A working copy may materialise a sparse subset or overlay another
  repository. The app shows what is on disk without explaining why it differs from the whole.
- **Anything it did not read this second.** There is no cache of repository state; every answer
  is re-read. The cost is a process per question; the benefit is never showing a stale truth.
