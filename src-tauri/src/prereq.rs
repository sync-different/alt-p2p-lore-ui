//! Prerequisite check (spec R3).
//!
//! The app ships everything it needs — the `lore` CLI, the alt-p2p-lore JAR, and a Java
//! runtime — so this is not "is the user's machine set up?" but "did the bundle arrive
//! intact, and does it actually run here?".
//!
//! That distinction drives the design: each tool is *executed* and its version captured,
//! rather than merely stat'ed. A present-but-unrunnable binary is the failure this catches
//! — wrong architecture, missing entitlement, quarantine flag, truncated copy — and every
//! one of those looks identical to a file-exists check.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

/// How long any single version probe may take. These are local `--version` calls that
/// return in milliseconds; a second is already pathological. Bounded because a hung probe
/// at startup would leave the user staring at a blank window with nothing to act on.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug)]
pub struct ToolStatus {
    /// Stable key for the UI: "lore", "alt-p2p-lore", "java".
    pub id: String,
    /// Human label.
    pub name: String,
    pub ok: bool,
    /// Version string as the tool reports it, e.g. "lore 0.9.0+783".
    pub version: Option<String>,
    /// Present only when `ok` is false — phrased for a non-technical reader.
    pub problem: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Prerequisites {
    pub all_ok: bool,
    pub tools: Vec<ToolStatus>,
    /// What `fetch-deps.sh` recorded at build time, so a running app can say which
    /// payload it was built from. Absent in an unbundled dev run.
    pub build_manifest: Option<serde_json::Value>,
}

fn ok(id: &str, name: &str, version: String) -> ToolStatus {
    ToolStatus {
        id: id.into(),
        name: name.into(),
        ok: true,
        version: Some(version.trim().to_string()),
        problem: None,
    }
}

fn bad(id: &str, name: &str, problem: impl Into<String>) -> ToolStatus {
    ToolStatus {
        id: id.into(),
        name: name.into(),
        ok: false,
        version: None,
        problem: Some(problem.into()),
    }
}

/// Run a sidecar with args and return its first line of output.
///
/// Both stdout and stderr are considered: `--version` goes to stderr in plenty of tools,
/// and treating that as failure would report a perfectly good binary as broken.
async fn probe(app: &AppHandle, sidecar: &str, args: Vec<String>) -> Result<String, String> {
    let cmd = app
        .shell()
        .sidecar(sidecar)
        .map_err(|e| format!("not found in the app bundle ({e})"))?
        .args(args);

    let output = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "timed out — the program started but never answered".to_string())?
        .map_err(|e| format!("could not be run ({e})"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let first = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .or_else(|| stderr.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or("")
        .to_string();

    if first.is_empty() {
        return Err("ran but reported no version".into());
    }
    Ok(first)
}

#[tauri::command]
pub async fn check_prerequisites(app: AppHandle) -> Result<Prerequisites, String> {
    let mut tools = Vec::new();

    // --- lore CLI ---------------------------------------------------------
    match probe(&app, "lore", vec!["--version".into()]).await {
        Ok(v) => tools.push(ok("lore", "Lore", v)),
        Err(e) => tools.push(bad("lore", "Lore", format!("The bundled Lore program {e}."))),
    }

    // --- Java runtime + alt-p2p-lore JAR ----------------------------------
    // Resolved through Tauri rather than assembled by hand, because the layout differs
    // between `tauri dev` (flat, next to the binary) and a packaged .app
    // (Contents/Resources). Hardcoding either one works in exactly one of them.
    let jar = app
        .path()
        .resolve("alt-p2p-lore.jar", tauri::path::BaseDirectory::Resource);

    match jar {
        Ok(jar_path) if jar_path.exists() => {
            let p = jar_path.to_string_lossy().to_string();
            match probe(&app, "run-java", vec!["-jar".into(), p, "--version".into()]).await {
                Ok(v) => {
                    tools.push(ok("alt-p2p-lore", "Alterante P2P", v));
                    // The JAR running at all proves a working JVM, so report it as one
                    // check rather than probing java separately and confusing the user
                    // with two lines that always agree.
                    match probe(&app, "run-java", vec!["-version".into()]).await {
                        Ok(jv) => tools.push(ok("java", "Java runtime", jv)),
                        Err(e) => tools.push(bad("java", "Java runtime", format!("Present, but {e}."))),
                    }
                }
                Err(e) => {
                    tools.push(bad("alt-p2p-lore", "Alterante P2P", format!("The bundled connection program {e}.")));
                    tools.push(bad("java", "Java runtime", "Not reached, because the connection program did not run."));
                }
            }
        }
        _ => {
            tools.push(bad("alt-p2p-lore", "Alterante P2P", "Missing from the app bundle."));
            tools.push(bad("java", "Java runtime", "Not reached, because the connection program is missing."));
        }
    }

    let build_manifest = app
        .path()
        .resolve("deps-manifest.json", tauri::path::BaseDirectory::Resource)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());

    Ok(Prerequisites {
        all_ok: tools.iter().all(|t| t.ok),
        tools,
        build_manifest,
    })
}
