//! Starting, watching and stopping tunnels.
//!
//! One `alt-p2p-lore connect --json` child per connected session. Its stdout is a stream of
//! events; this module turns that stream into registry state and forwards it to the UI.
//!
//! Three properties the sibling transfer app lacks, and which a many-tunnel app cannot do
//! without:
//!
//! - **The child is owned by Rust.** The webview holds an id. A component unmounting, or a
//!   tab closing, cannot orphan a process.
//! - **Death is noticed.** The reader task runs until the child terminates, and records why.
//!   A tunnel that dies silently is one the UI would keep drawing as connected.
//! - **argv is built here.** The PSK never crosses the IPC boundary into JavaScript, and is
//!   redacted from anything logged.

use super::event::{parse_line, TunnelEvent, TunnelMode, TunnelPhase};
use crate::lore::cmd::redact;
use crate::registry::{Registry, TunnelInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// What the frontend needs to start a tunnel.
///
/// The PSK arrives once, from the keychain via Rust — see `session::connect`. It is in this
/// struct rather than read from a store here so the same code path serves a saved session
/// and a one-off connection.
#[derive(Deserialize, Clone, Debug)]
pub struct TunnelConfig {
    /// Which saved session this is, for display.
    pub session_name: String,
    /// alt-p2p session id (the rendezvous name, not a secret).
    pub session_id: String,
    pub psk: String,
    /// Coordinator, e.g. "coord.example.com:9000".
    pub server: String,
    /// Local port to expose loreserver on.
    pub loreserver_port: u16,
    /// Must equal the port in the host's advertised auth_url — see PLAN.md O1. Absent for
    /// an unauthenticated host.
    pub identity_port: Option<u16>,
    /// Allow falling back through the coordinator's relay. On by default in practice:
    /// ctone's own hosts fall back routinely.
    #[serde(default = "default_true")]
    pub allow_relay: bool,
}

fn default_true() -> bool {
    true
}

/// What kind of event this is, independent of the phase it carries.
///
/// Needed because two different events legitimately report the connected phase: the peer
/// link coming up (`Status`), and the local port being ready to use (`TunnelReady`). Both
/// are worth recording, but announcing both put "Connected" in the Activity feed twice.
/// Phase alone cannot tell them apart — this can.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    /// Progress. Moves the tab colour; says nothing in the feed.
    Status,
    /// The tunnel is usable — this is the one worth announcing, and the only one that
    /// knows whether the route is direct or relayed.
    Ready,
    /// The tunnel reported a failure of its own.
    Failed,
    /// The process ended.
    Exited,
}

/// One event, addressed to a tunnel, as delivered to the UI.
#[derive(Serialize, Clone, Debug)]
pub struct TunnelUpdate {
    pub kind: UpdateKind,
    pub id: String,
    pub phase: TunnelPhase,
    pub detail: String,
    pub mode: Option<TunnelMode>,
    pub url: Option<String>,
    pub error: Option<String>,
}

/// The Tauri event name the frontend listens on.
pub const TUNNEL_EVENT: &str = "tunnel://update";

/// What actually goes on the wire: the update plus who it is about.
///
/// The name is attached here rather than at each construction site because the registry
/// already knows it and the emitting code often does not — `handle_event` holds an id and
/// nothing else. Without it the Activity feed showed a wall of "Connected" and "Punching"
/// with no way to tell which session each line belonged to, which is exactly the situation
/// the feed exists to resolve when several tunnels are open at once.
#[derive(Serialize, Clone)]
struct Emitted<'a> {
    #[serde(flatten)]
    update: &'a TunnelUpdate,
    session_id: String,
    session_name: String,
}

fn emit(app: &AppHandle, update: TunnelUpdate) {
    let (session_id, session_name) = app
        .state::<Registry>()
        .get(&update.id)
        .map(|i| (i.session_id, i.session_name))
        .unwrap_or_default();
    // A failure to emit means the window has gone; the registry is still authoritative, so
    // there is nothing useful to do about it here.
    let _ = app.emit(
        TUNNEL_EVENT,
        Emitted { update: &update, session_id, session_name },
    );
}

/// Start a tunnel. Returns its id immediately — connection happens asynchronously, and the
/// UI follows it through `tunnel://update`.
#[tauri::command]
pub async fn start_tunnel(app: AppHandle, config: TunnelConfig) -> Result<String, String> {
    let registry = app.state::<Registry>();

    // Refuse a collision before spending a process on it. Two hosts advertising the same
    // auth_url port cannot both be tunnelled, because `lore` files tokens under that exact
    // URL — see PLAN.md O1. Said plainly here rather than surfacing a bind error from deep
    // inside the child, which names a port the user never chose.
    if let Some(port) = config.identity_port {
        if let Some(holder) = registry.identity_port_in_use(port) {
            return Err(format!(
                "“{holder}” is already using identity port {port}. Only one session can use \
                 a given identity port at a time — disconnect it first, or give this host a \
                 different auth_url port."
            ));
        }
    }

    // One process per session, enforced before spawning a second.
    //
    // A duplicate is not a harmless wasted process: the session id is the rendezvous name,
    // and a REGISTER on an already-paired session recycles the coordinator's slots, so the
    // newcomer re-points the host at itself and breaks the tunnel that was working. It also
    // collides on the same local port. Both were happening — two children of this app on
    // `lore-…-win-#v3`, both on 41500, one connected and one punching indefinitely.
    if let Some((existing, connected)) = registry.live_for_session(&config.session_id) {
        if connected {
            // Connect is idempotent. The UI asking again means its picture was stale, and
            // refreshing it is the right answer — not a second peer.
            eprintln!("tunnel {existing} already serves session; reusing it");
            return Ok(existing);
        }
        // Still trying, and the user asked again: treat that as "retry", which means the
        // stuck attempt has to go first or it will hold the port the retry needs.
        eprintln!("replacing in-progress tunnel {existing} for the same session");
        registry.kill(&existing);
    }

    // Check the port here rather than letting the child discover it, because the child finds
    // out only *after* it has connected — it binds the listener last — so the failure lands
    // a minute late and looks like a connection problem rather than a local one.
    if let Err(e) = std::net::TcpListener::bind(("127.0.0.1", config.loreserver_port)) {
        return Err(format!(
            "Local port {} is not available ({e}). Another program on this machine is using \
             it — close it, or give this session a different local port.",
            config.loreserver_port
        ));
    }

    let jar = app
        .path()
        .resolve("alt-p2p-lore.jar", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("The bundled connection program is missing ({e})."))?;

    let mut args: Vec<String> = vec![
        "-jar".into(),
        jar.to_string_lossy().to_string(),
        "connect".into(),
        "--json".into(),
        "--local-port".into(),
        config.loreserver_port.to_string(),
        "-s".into(),
        config.session_id.clone(),
        "--psk".into(),
        config.psk.clone(),
        "--server".into(),
        config.server.clone(),
    ];
    if let Some(p) = config.identity_port {
        args.push("--identity-port".into());
        args.push(p.to_string());
    }
    if config.allow_relay {
        args.push("--allow-relay".into());
    }

    // Logged redacted, always. A secret only has to be printed once to be leaked.
    eprintln!("starting tunnel: run-java {}", redact(&args));

    let (mut rx, child) = app
        .shell()
        .sidecar("run-java")
        .map_err(|e| format!("The bundled connection program is missing ({e})."))?
        .args(args)
        .spawn()
        .map_err(|e| format!("The connection program could not be started ({e})."))?;

    // Ids are assigned here, not by the frontend: the registry is the authority on what
    // exists, and a caller-chosen id could collide with a live tunnel.
    let pid = child.pid();
    let id = format!("t{pid}");

    // Written down before the process can matter, so that a run which ends without warning
    // still leaves a record of what it started. See orphans.rs.
    let pid_path = crate::session::app_dir().ok().map(|d| crate::orphans::pid_file(&d));
    if let Some(ref path) = pid_path {
        crate::orphans::record(path, pid);
    }

    registry.insert(
        TunnelInfo {
            id: id.clone(),
            session_id: config.session_id.clone(),
            session_name: config.session_name.clone(),
            loreserver_port: config.loreserver_port,
            identity_port: config.identity_port,
            phase: TunnelPhase::Registering,
            mode: None,
            url: None,
            error: None,
        },
        child,
    );

    let app_for_task = app.clone();
    let id_for_task = id.clone();
    let pid_path_for_task = pid_path.clone();

    tauri::async_runtime::spawn(async move {
        // The tunnel writes its human log to stderr. When it exits without having emitted a
        // JSON error — a port already in use, a missing file, a JVM that would not start —
        // that log is the *only* record of why, and discarding it leaves the user with
        // "exited with code 1" and nothing to act on.
        let mut recent_stderr: Vec<String> = Vec::new();
        let mut saw_json_error = false;

        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    for l in line.lines() {
                        if let Some(parsed) = parse_line(l) {
                            if matches!(parsed, TunnelEvent::Error { .. }) {
                                saw_json_error = true;
                            }
                            handle_event(&app_for_task, &id_for_task, parsed);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for l in text.lines() {
                        let line = l.trim();
                        if line.is_empty() {
                            continue;
                        }
                        if line.contains("ERROR") || line.contains("WARN") {
                            eprintln!("tunnel {id_for_task}: {line}");
                        }
                        // A bounded tail: enough to explain a failure, small enough that a
                        // chatty tunnel running for hours cannot grow this without limit.
                        recent_stderr.push(line.to_string());
                        if recent_stderr.len() > 40 {
                            recent_stderr.remove(0);
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let registry = app_for_task.state::<Registry>();
                    let was_connected = registry
                        .get(&id_for_task)
                        .map(|i| i.phase.is_connected())
                        .unwrap_or(false);

                    // An exit after being connected is a *loss*, not a normal stop, and the
                    // user needs to know: everything that depends on the tunnel — diffs,
                    // locks, push — silently stops working otherwise.
                    let reason = if was_connected {
                        "The connection to the host ended.".to_string()
                    } else if saw_json_error {
                        // The error event already said why, and it said it better.
                        registry
                            .get(&id_for_task)
                            .and_then(|i| i.error)
                            .unwrap_or_else(|| "The connection failed.".to_string())
                    } else {
                        match payload.code {
                            Some(0) => "The connection stopped.".to_string(),
                            // An exit code alone is not information a user can act on. The
                            // tunnel's own last words usually are.
                            Some(c) => explain_exit(c, &recent_stderr),
                            None => "The connection program was stopped.".to_string(),
                        }
                    };

                    // The registry knows whether this exit was asked for; the process does
                    // not, because a killed child exits non-zero exactly like a crashed one.
                    let phase = registry.mark_stopped(&id_for_task, &reason);
                    let intentional = phase == TunnelPhase::Stopped;
                    if let Some(ref path) = pid_path_for_task {
                        crate::orphans::forget(path, pid);
                    }
                    emit(
                        &app_for_task,
                        TunnelUpdate {
                            kind: UpdateKind::Exited,
                            id: id_for_task.clone(),
                            phase,
                            detail: if intentional {
                                "Disconnected.".to_string()
                            } else {
                                reason.clone()
                            },
                            mode: None,
                            url: None,
                            error: (!intentional).then_some(reason),
                        },
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(id)
}

fn handle_event(app: &AppHandle, id: &str, event: TunnelEvent) {
    let registry = app.state::<Registry>();

    match event {
        TunnelEvent::Status { state } => {
            registry.set_phase(id, state.clone());
            emit(
                app,
                TunnelUpdate {
                    kind: UpdateKind::Status,
                    id: id.into(),
                    detail: state.describe().to_string(),
                    phase: state,
                    mode: None,
                    url: None,
                    error: None,
                },
            );
        }
        TunnelEvent::TunnelReady { url, port: _, mode } => {
            registry.set_ready(id, &url, mode.clone());
            emit(
                app,
                TunnelUpdate {
                    kind: UpdateKind::Ready,
                    id: id.into(),
                    phase: TunnelPhase::Connected,
                    detail: match mode {
                        TunnelMode::Relay => {
                            "Connected through the relay — slower than a direct connection."
                                .to_string()
                        }
                        _ => "Connected".to_string(),
                    },
                    mode: Some(mode),
                    url: Some(url),
                    error: None,
                },
            );
        }
        TunnelEvent::Error { message } => {
            registry.set_error(id, &message);
            emit(
                app,
                TunnelUpdate {
                    kind: UpdateKind::Failed,
                    id: id.into(),
                    phase: TunnelPhase::Error,
                    detail: friendly_error(&message),
                    mode: None,
                    url: None,
                    error: Some(message),
                },
            );
        }
        TunnelEvent::Unknown => {}
    }
}

/// Explain a bare exit code using whatever the tunnel last said on stderr.
///
/// The common causes have recognisable signatures, and naming them saves the user reading a
/// Java stack trace to discover that a port is busy.
pub fn explain_exit(code: i32, stderr_tail: &[String]) -> String {
    let joined = stderr_tail.join("\n");
    let lower = joined.to_lowercase();

    if lower.contains("address already in use") || lower.contains("bindexception") {
        return "That local port is already in use. Another program — or another session in \
                this app — is using it. Edit the session and choose a different local port."
            .to_string();
    }
    if lower.contains("unknownhost") || lower.contains("nodename nor servname") {
        return "The coordinator address could not be found. Check it for typing mistakes."
            .to_string();
    }
    if lower.contains("connection refused") {
        return "The coordinator refused the connection. It may be switched off.".to_string();
    }
    if lower.contains("could not find or load main class") || lower.contains("no java runtime") {
        return "The bundled connection program could not start. Reinstalling the app should \
                fix it."
            .to_string();
    }

    // Nothing recognised: give the tunnel's own last words rather than a number alone.
    let tail: Vec<&String> = stderr_tail.iter().rev().take(3).collect();
    if tail.is_empty() {
        format!("The connection program stopped unexpectedly (exit code {code}).")
    } else {
        let detail: Vec<String> = tail.into_iter().rev().cloned().collect();
        format!(
            "The connection program stopped unexpectedly (exit code {code}). It last reported: {}",
            detail.join(" / ")
        )
    }
}

/// Turn the tunnel's own message into something a non-technical reader can act on.
///
/// The raw text is kept alongside — this replaces the headline, not the evidence.
pub fn friendly_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("authentication failed") {
        "The key for this session was not accepted. Check the session key.".into()
    } else if lower.contains("session full") {
        "That session already has two peers connected.".into()
    } else if lower.contains("timed out waiting for peer") || lower.contains("waiting for peer") {
        "The host did not answer. It may be switched off.".into()
    } else if lower.contains("hole punch failed") {
        "Could not reach the host directly, and relaying is not enabled for this session.".into()
    } else {
        raw.to_string()
    }
}

/// Stop a tunnel.
#[tauri::command]
pub fn stop_tunnel(app: AppHandle, id: String) -> Result<bool, String> {
    Ok(app.state::<Registry>().kill(&id))
}

#[cfg(test)]
mod tests {
    use super::friendly_error;

    #[test]
    fn explains_a_rejected_key() {
        let msg = friendly_error("Authentication failed: 0x0002: Authentication failed");
        assert!(msg.contains("session key"), "got {msg}");
        assert!(!msg.contains("0x0002"), "the code belongs in the details, not the headline");
    }

    #[test]
    fn explains_an_absent_host() {
        assert!(friendly_error("Timed out waiting for peer").contains("switched off"));
    }

    #[test]
    fn explains_a_full_session() {
        assert!(friendly_error("Session full").contains("two peers"));
    }

    #[test]
    fn passes_an_unrecognised_message_through_unchanged() {
        // Inventing a friendly phrasing for something we do not understand would replace
        // real information with a guess.
        let raw = "Some failure nobody has seen before";
        assert_eq!(friendly_error(raw), raw);
    }
}
