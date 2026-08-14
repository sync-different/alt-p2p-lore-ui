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
use tauri_plugin_shell::ShellExt;

/// Default ceiling for a repository command.
///
/// Generous next to the 0.06s a status takes on a 2 GB repository, because it also covers
/// operations that touch a lot of files. It exists to end a hang, not to police latency.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

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
    let output = match tokio::time::timeout(limit, cmd.output()).await {
        Err(_) => {
            let e = LoreError::TimedOut { seconds: limit.as_secs(), command: pretty.clone() };
            trace(app, &pretty, cwd, started, None, Some(&e.to_string()));
            return Err(e);
        }
        Ok(Err(e)) => {
            let e = LoreError::Spawn(e.to_string());
            trace(app, &pretty, cwd, started, None, Some(&e.to_string()));
            return Err(e);
        }
        Ok(Ok(o)) => o,
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code();

    if !output.status.success() {
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
    use super::redact;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
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
