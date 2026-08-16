//! Running the bundled `lore` CLI.
//!
//! Every repository operation in this app is a short-lived `lore` invocation with a working
//! directory. Three properties are non-negotiable and easier to build in than to add later:
//!
//! - **Bounded.** A hung child must not pin a UI action forever. Everything here has a
//!   deadline.
//! - **Redacted.** Nothing that could carry a credential reaches a log in the clear.
//! - **Resolved, not searched.** The sidecar is located through Tauri, never via `PATH` —
//!   a macOS GUI app does not inherit the shell environment, so `PATH` lookups work when
//!   launched from a terminal and fail for everyone else.

use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Default ceiling for a repository command.
///
/// Generous next to the 0.06s a status takes on a 2 GB repository, because it also covers
/// operations that touch a lot of files. It exists to end a hang, not to police latency.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Deadline for an operation that moves the repository's data over the network.
///
/// `commit` uploads every changed fragment to the host's immutable store, and `sync` pulls
/// the remote's changes down — both scale with the *data*, not with a fixed cost, and on a
/// large repository or a slow link they run for minutes. The default 120s is far too short:
/// a sync that pulled a multi-hundred-MB delta failed with "did not finish within 120s" while
/// it was progressing perfectly, and `sync` even carried a comment saying it must *not* be
/// capped — but passed `None`, which resolves to the 120s default rather than to no cap.
///
/// One hour is chosen to cover a genuinely large transfer over a poor connection while still
/// ending a truly hung process rather than hanging forever. It is a stopgap: the correct fix
/// is to stream these like `clone` and bound them on *liveness* (no output for N seconds)
/// rather than on wall-clock — which would also give them the progress feedback they lack.
pub const DATA_TRANSFER_TIMEOUT: Duration = Duration::from_secs(3600);

/// Deadline for a read the user is waiting on.
///
/// The default is sized for operations that move data; a *read* inheriting it means a host
/// that has stopped answering takes two minutes to say so, per call. Observed against a
/// machine that went to sleep: `lore status --scan` at 22.4s, 19.2s and 10.3s in a row, and
/// only the app's own guard now stops those adding up — the ceiling was never reached because
/// the host was refusing rather than hanging. A hung one would have taken the full 120s each.
///
/// Twenty seconds is far above what these cost when they work: a status scan of the 2 GiB
/// reference repository is 225ms cold and 83ms warm. It exists to end a wait, not to police
/// latency, so it is set where no working host could plausibly land.
pub const INTERACTIVE_TIMEOUT: Duration = Duration::from_secs(20);

/// Deadline for a read that needs the host and has nothing local to fall back on.
///
/// Locks are the case: `lore` gives up on its own at about ten seconds with "Disconnected
/// from server", so a longer deadline here would only add silence after the CLI had already
/// decided. Matching it keeps the app's answer as prompt as the tool's.
pub const HOST_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Deadline for `lore status --scan`.
///
/// `--scan` walks the working copy and **hashes file content** to detect changes, so it scales
/// with the size of the repository, not with a fixed cost. On a large one — the reference case
/// is two 4 GB files — a scan runs for minutes, and the shorter read deadlines failed a re-read
/// that was working: "did not finish within 120s" fired straight after a discard that had
/// already restored the file. Sized like a data transfer, for the same reason.
///
/// Crucially this is **not** the host-hang guard the other read deadlines are. A `--scan`
/// completes on a *down* host (it omits the remote lines), and a *hung* host is caught within
/// 15s by the reachability probe, independently of this call — so a long deadline here cannot
/// leave the UI stuck on a sleeping host. It only stops a legitimately large local scan from
/// being killed mid-work.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(3600);

#[derive(Serialize, Clone, Debug)]
pub struct LoreOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub success: bool,
}

#[derive(Debug)]
pub enum LoreError {
    /// The sidecar is missing from the bundle.
    NotFound(String),
    /// Exceeded its deadline.
    TimedOut { seconds: u64, command: String },
    /// Ran, and failed.
    Failed { code: Option<i32>, stderr: String, command: String },
    /// Could not be started at all.
    Spawn(String),
}

impl std::fmt::Display for LoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoreError::NotFound(e) => write!(f, "The bundled Lore program is missing ({e})."),
            LoreError::TimedOut { seconds, command } => {
                write!(f, "`lore {command}` did not finish within {seconds}s.")
            }
            // stderr is included because lore's own message is almost always more useful
            // than anything we could invent, and hiding it makes reports unanswerable.
            LoreError::Failed { code, stderr, command } => {
                let detail = stderr.trim();
                if detail.is_empty() {
                    write!(f, "`lore {command}` failed (exit {}).", code.unwrap_or(-1))
                } else {
                    write!(f, "`lore {command}` failed: {detail}")
                }
            }
            LoreError::Spawn(e) => write!(f, "The bundled Lore program could not be started ({e})."),
        }
    }
}

impl std::error::Error for LoreError {}

/// Hide anything that follows a credential-bearing flag.
///
/// Applied wherever arguments are recorded — logs, error messages, the Activity feed. A
/// secret only has to be printed once to be leaked, and the reference implementation
/// redacts at the point of formatting for exactly that reason.
pub fn redact(args: &[String]) -> String {
    const SECRET_FLAGS: &[&str] = &["--psk", "--token", "--password", "--secret"];
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut hide_next = false;
    for a in args {
        if hide_next {
            out.push("***".into());
            hide_next = false;
            continue;
        }
        if SECRET_FLAGS.contains(&a.as_str()) {
            hide_next = true;
        }
        // Also catch the --flag=value spelling, which a positional check alone misses.
        if let Some((flag, _)) = a.split_once('=') {
            if SECRET_FLAGS.contains(&flag) {
                out.push(format!("{flag}=***"));
                continue;
            }
        }
        // A credential that arrives somewhere this list does not expect — positionally, or
        // behind a flag added later — is still a credential. Since these strings are now
        // *displayed*, in the debug console, shape is checked as well as position.
        if looks_like_a_token(a) {
            out.push("***".into());
            continue;
        }
        out.push(a.clone());
    }
    out.join(" ")
}

/// Append user-supplied positional values after a `--` separator.
///
/// Everything before `--` is the app's own flags; everything after is data, however it looks.
/// Without this, a branch named `-wip`, a commit message beginning `-`, or a file called
/// `-report.txt` is parsed by `lore` as an option: it fails with `unexpected argument '-w'`
/// or, worse for a branch, `the following required arguments were not provided: <branch>` —
/// an error that names nothing the user did. `lore` itself prints the fix in that message
/// (`tip: to pass '-r' as a value, use '-- -r'`), and accepts `--` on every subcommand tested,
/// including those with no positional and a trailing separator.
///
/// A single choke point rather than a `--` at each call site, because the failure mode of
/// forgetting one is silent until somebody types a leading dash — exactly the input nobody
/// tries until a user does.
pub fn with_positional(mut flags: Vec<String>, positionals: impl IntoIterator<Item = String>) -> Vec<String> {
    let values: Vec<String> = positionals.into_iter().collect();
    if !values.is_empty() {
        flags.push("--".into());
        flags.extend(values);
    }
    flags
}

/// Does this argument look like a JWT?
///
/// Three dot-separated segments of base64url, the middle one long enough to be a payload.
/// Deliberately narrow: a false positive replaces a path with `***` in a diagnostic tool,
/// which is annoying, while a false negative prints somebody's bearer token on screen.
fn looks_like_a_token(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts[1].len() >= 20
        && parts.iter().all(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

/// Run `lore` in `cwd` and return its output.
///
/// A non-zero exit is an `Err`, because every caller would otherwise have to remember to
/// check — and the one that forgets parses an error message as data.
pub async fn run(
    app: &AppHandle,
    cwd: &Path,
    args: Vec<String>,
    timeout: Option<Duration>,
) -> Result<LoreOutput, LoreError> {
    let pretty = redact(&args);
    let started = std::time::Instant::now();

    let cmd = app
        .shell()
        .sidecar("lore")
        .map_err(|e| {
            let e = LoreError::NotFound(e.to_string());
            trace(app, &pretty, cwd, started, None, Some(&e.to_string()));
            e
        })?
        .current_dir(cwd.to_path_buf())
        .args(args);

    let limit = timeout.unwrap_or(DEFAULT_TIMEOUT);

    // Spawn and stream rather than buffer with `.output()`. `lore` narrates the long operations
    // as it works — `Fragmenting files…`, `Committing staged changes`, `Synchronizing to
    // revision…`, warnings — and that narration is exactly what the debug console is for. A
    // commit or sync that moves gigabytes is then legible *while* it runs, one line at a time,
    // instead of appearing frozen and then dumping everything at the end. The full output is
    // still accumulated for the return value, the error, and the one-line trace.
    let (mut rx, mut child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            let e = LoreError::Spawn(e.to_string());
            trace(app, &pretty, cwd, started, None, Some(&e.to_string()));
            return Err(e);
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None;

    let pump = async {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for l in text.lines() {
                        if !l.trim().is_empty() {
                            emit_line(app, &pretty, "out", l);
                        }
                    }
                    stdout.push_str(&text);
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for l in text.lines() {
                        if !l.trim().is_empty() {
                            emit_line(app, &pretty, "err", l);
                        }
                    }
                    stderr.push_str(&text);
                }
                CommandEvent::Terminated(payload) => code = payload.code,
                _ => {}
            }
        }
    };

    if tokio::time::timeout(limit, pump).await.is_err() {
        // Deadline hit: kill the child so it cannot outlive the call (the same orphan the old
        // `.output()` path left behind on timeout — `timeout` only drops the future), then report.
        let _ = child.kill();
        let e = LoreError::TimedOut { seconds: limit.as_secs(), command: pretty.clone() };
        trace(app, &pretty, cwd, started, None, Some(&e.to_string()));
        return Err(e);
    }

    if code != Some(0) {
        trace(app, &pretty, cwd, started, code, Some(stderr.trim()));
        return Err(LoreError::Failed { code, stderr, command: pretty });
    }

    trace(app, &pretty, cwd, started, code, None);
    Ok(LoreOutput { stdout, stderr, code, success: true })
}

/// One line for the debug console: what ran, where, how long it took, and how it ended.
#[derive(Serialize, Clone, Debug)]
pub struct LoreTrace {
    /// Already redacted — this is the string that reaches the screen.
    pub command: String,
    pub cwd: String,
    pub ms: u64,
    pub code: Option<i32>,
    pub ok: bool,
    /// Why it failed, trimmed. Absent on success.
    pub error: Option<String>,
}

/// The event name the console listens on.
pub const TRACE_EVENT: &str = "lore://command";

/// A single line of a `lore` command's live output, on its way to the debug console.
#[derive(Serialize, Clone, Debug)]
pub struct LoreLine {
    /// The redacted command this line belongs to, so the console can attribute it — several
    /// commands can be in flight at once (a background read while a commit runs).
    pub command: String,
    /// `"out"` or `"err"`.
    pub stream: String,
    /// Already redacted — this is the string that reaches the screen.
    pub line: String,
}

/// The event name the console listens on for streamed command output.
pub const OUTPUT_EVENT: &str = "lore://output";

/// Redact any token-shaped word in a line before it is displayed.
///
/// The command *arguments* are already redacted by `redact`; this is the same guard for the
/// command's *output*, which is now shown on screen too. `lore`'s repository output is phase
/// text and hashes — no credentials — but `auth` output can carry one, and a diagnostic must
/// never be the thing that prints a bearer token. Narrow by the same JWT shape test, so a false
/// positive only ever blanks one hash-like word rather than swallowing a whole line.
fn redact_line(line: &str) -> String {
    // Fast path: a JWT has dots, so a line without one cannot contain the shape we hide.
    if !line.contains('.') {
        return line.to_string();
    }
    line.split(' ')
        .map(|w| if looks_like_a_token(w) { "***" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Emit one line of command output to the console. Failures to emit are ignored, for the same
/// reason as `trace`: a diagnostic must not be able to break the operation it describes.
///
/// Public so `clone` — which runs `lore` through a pseudo-terminal rather than through `run`,
/// and so bypasses the streaming above — can put its own narration on the same console stream.
pub fn emit_line(app: &AppHandle, command: &str, stream: &str, line: &str) {
    let _ = app.emit(
        OUTPUT_EVENT,
        LoreLine {
            command: command.to_string(),
            stream: stream.to_string(),
            line: redact_line(line),
        },
    );
}

/// Emit a trace, always.
///
/// Not gated on a debug setting: the console's value is being able to turn it on *after*
/// something went wrong and still see what led there. The volume is a handful of events per
/// user action, so the cost of always emitting is far below the cost of a switch that only
/// helps people who predicted they would need it.
///
/// Failures to emit are ignored. A diagnostic that can break the operation it is describing
/// is worse than no diagnostic.
fn trace(
    app: &AppHandle,
    command: &str,
    cwd: &Path,
    started: std::time::Instant,
    code: Option<i32>,
    error: Option<&str>,
) {
    let payload = LoreTrace {
        command: command.to_string(),
        cwd: cwd.display().to_string(),
        ms: started.elapsed().as_millis() as u64,
        code,
        ok: error.is_none(),
        // A whole stderr dump would drown the console; the first line is the message and the
        // rest is a source-location trace that belongs in the error the caller already shows.
        error: error.map(|e| e.lines().next().unwrap_or(e).trim().to_string()),
    };
    let _ = app.emit(TRACE_EVENT, payload);
}

#[cfg(test)]
mod tests {
    use super::{redact, redact_line, with_positional};

    #[test]
    fn output_lines_hide_token_shaped_words_but_keep_hashes() {
        // A commit prints hashes freely — those must survive, or the console is useless.
        let hash = "Signature : 66b219262de3e3aa461502dbf2d4b52fa01432f25acec1f9ffdad5d3f3e894a2";
        assert_eq!(redact_line(hash), hash, "a bare hex hash is not a JWT and must show");
        // A three-segment JWT anywhere in a line is blanked.
        let jwt = "eyJhbGciOiJI.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4.dozjgNryP4J3";
        let redacted = redact_line(&format!("token stored: {jwt}"));
        assert!(!redacted.contains(jwt), "a JWT-shaped word must be hidden");
        assert!(redacted.contains("***"));
        // A line with no dot at all takes the fast path unchanged.
        assert_eq!(redact_line("Fragmenting files and updating tree hashes"), "Fragmenting files and updating tree hashes");
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_read_never_waits_as_long_as_a_transfer() {
        // The point of having three: a host that stops answering must not cost two minutes
        // per read. Written as an ordering rather than as exact numbers, so tuning stays
        // possible while the relationship that matters is pinned.
        assert!(super::HOST_READ_TIMEOUT < super::INTERACTIVE_TIMEOUT);
        assert!(super::INTERACTIVE_TIMEOUT < super::DEFAULT_TIMEOUT);
        // Comfortably above a working host: a status scan of the 2 GiB reference repository
        // is 225ms cold. A deadline near that would fail on an ordinary slow moment.
        assert!(super::INTERACTIVE_TIMEOUT.as_secs() >= 10);
        // A data transfer (commit/sync) is the longest of all — it moves gigabytes and must
        // outrun the 120s default, which failed a legitimate large sync mid-progress (B7).
        assert!(super::DATA_TRANSFER_TIMEOUT > super::DEFAULT_TIMEOUT);
        assert!(super::DATA_TRANSFER_TIMEOUT.as_secs() >= 1800);
        // A status --scan hashes file content, so it scales with the repository like a transfer
        // rather than like a quick read — it must outrun the 120s default too, which failed a
        // post-write re-read on a large repo ("did not finish within 120s" after a good discard).
        assert!(super::SCAN_TIMEOUT > super::DEFAULT_TIMEOUT);
    }

    #[test]
    fn positionals_are_placed_after_a_separator() {
        // The bug this prevents, reproduced live against lore 0.8.6: a branch named "-wip", a
        // commit message "-oops", a file "-report.txt" were each parsed as an option. lore
        // failed with "unexpected argument '-w'" or, for a branch, "required arguments were
        // not provided: <branch>" — an error naming nothing the user did.
        let args = with_positional(vec!["commit".into()], ["-oops".to_string()]);
        assert_eq!(args, vec!["commit", "--", "-oops"]);
    }

    #[test]
    fn a_dash_prefixed_value_is_protected() {
        let args = with_positional(
            vec!["stage".into(), "--scan".into()],
            ["-report.txt".to_string(), "normal.txt".to_string()],
        );
        // Real flags stay before the separator; every user value goes after it.
        assert_eq!(args, vec!["stage", "--scan", "--", "-report.txt", "normal.txt"]);
    }

    #[test]
    fn no_separator_is_added_when_there_is_nothing_to_protect() {
        // A bare `--` with no positional is accepted by lore, but adding one for nothing is
        // noise in every logged command, and the empty case is common (a status with no args).
        let args = with_positional(vec!["branch".into(), "list".into()], std::iter::empty());
        assert_eq!(args, vec!["branch", "list"]);
    }

    #[test]
    fn a_value_that_merely_contains_a_dash_still_works() {
        // The common case must not regress: most paths and branches have dashes in the middle.
        let args = with_positional(vec!["branch".into(), "create".into()], ["feature-x".to_string()]);
        assert_eq!(args, vec!["branch", "create", "--", "feature-x"]);
    }

    #[test]
    fn hides_the_value_after_a_secret_flag() {
        assert_eq!(redact(&v(&["connect", "--psk", "hunter2"])), "connect --psk ***");
    }

    #[test]
    fn hides_the_equals_spelling_too() {
        // The spelling that a positional-only check silently lets through.
        assert_eq!(redact(&v(&["--token=abc.def.ghi"])), "--token=***");
    }

    #[test]
    fn leaves_ordinary_arguments_alone() {
        assert_eq!(redact(&v(&["status", "--offline"])), "status --offline");
    }

    #[test]
    fn a_trailing_secret_flag_does_not_panic() {
        assert_eq!(redact(&v(&["connect", "--psk"])), "connect --psk");
    }

    #[test]
    fn hides_a_token_by_shape_wherever_it_appears() {
        // These strings are now *displayed*, in the debug console. A credential passed
        // positionally, or behind a flag nobody added to the list, would otherwise be printed
        // on screen — and a secret only has to be shown once.
        let jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1LTg3YzRiOGM4YjdmNDRmYzEifQ.c2ln";
        assert_eq!(redact(&v(&["auth", "login", jwt])), "auth login ***");
    }

    #[test]
    fn does_not_mistake_an_ordinary_argument_for_a_token() {
        // A false positive turns a path into *** in a diagnostic tool, so the shape test is
        // deliberately narrow: three segments, and a payload long enough to be one.
        assert_eq!(redact(&v(&["status", "a.b.c"])), "status a.b.c");
        assert_eq!(
            redact(&v(&["clone", "grpc://127.0.0.1:41337"])),
            "clone grpc://127.0.0.1:41337"
        );
        assert_eq!(redact(&v(&["diff", "Art/Rig.v2.uasset"])), "diff Art/Rig.v2.uasset");
    }

    #[test]
    fn redacts_every_occurrence_not_just_the_first() {
        assert_eq!(
            redact(&v(&["--psk", "a", "--token", "b"])),
            "--psk *** --token ***"
        );
    }
}
