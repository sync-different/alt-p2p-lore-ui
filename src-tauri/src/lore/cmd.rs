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
use tauri::AppHandle;
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
        out.push(a.clone());
    }
    out.join(" ")
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

    let cmd = app
        .shell()
        .sidecar("lore")
        .map_err(|e| LoreError::NotFound(e.to_string()))?
        .current_dir(cwd.to_path_buf())
        .args(args);

    let limit = timeout.unwrap_or(DEFAULT_TIMEOUT);
    let output = tokio::time::timeout(limit, cmd.output())
        .await
        .map_err(|_| LoreError::TimedOut { seconds: limit.as_secs(), command: pretty.clone() })?
        .map_err(|e| LoreError::Spawn(e.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(LoreError::Failed {
            code: output.status.code(),
            stderr,
            command: pretty,
        });
    }

    Ok(LoreOutput { stdout, stderr, code: output.status.code(), success: true })
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
    fn redacts_every_occurrence_not_just_the_first() {
        assert_eq!(
            redact(&v(&["--psk", "a", "--token", "b"])),
            "--psk *** --token ***"
        );
    }
}
