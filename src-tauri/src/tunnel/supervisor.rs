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
    /// Skip the punch and go straight to the relay. See `session::Session::force_relay`.
    #[serde(default)]
    pub force_relay: bool,
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

/// One raw line from a tunnel process, for the debug console.
///
/// The supervisor parses stdout into typed events and keeps a bounded stderr tail for the exit
/// message; everything else was discarded. That is fine until a connection fails in a way none
/// of the recognisers know about, at which point the app's summary is all that is left and the
/// jar's own account of what it tried — coordinator, punch, relay — is gone. This forwards it.
#[derive(Serialize, Clone)]
pub struct TunnelOutput {
    pub session_id: String,
    pub session_name: String,
    /// `out` or `err`. Java logs progress to stderr, so this is not a severity.
    pub stream: &'static str,
    /// `info` | `warn` | `error`, read from the line itself.
    pub level: &'static str,
    pub line: String,
}

pub const OUTPUT_EVENT: &str = "tunnel://output";

/// Severity of a log line, by what the tunnel's own logger wrote.
///
/// Read from content rather than from the stream, because Java logs everything to stderr —
/// treating that as failure would paint an ordinary connection red.
pub fn line_level(line: &str) -> &'static str {
    if line.contains("ERROR") || line.contains("SEVERE") || line.contains("Exception") {
        "error"
    } else if line.contains("WARN") {
        "warn"
    } else {
        "info"
    }
}

/// Forward one line, scrubbed.
///
/// `redact` is applied even though these are the jar's own logs and not our argument vector:
/// this text is now *displayed*, and a program that logs its own command line — or a future
/// version that does — must not be the reason a session key ends up on screen.
fn emit_output(app: &AppHandle, id: &str, stream: &'static str, line: &str) {
    let (session_id, session_name) = app
        .state::<Registry>()
        .get(id)
        .map(|i| (i.session_id, i.session_name))
        .unwrap_or_default();
    let scrubbed = crate::lore::cmd::redact(
        &line.split_whitespace().map(|s| s.to_string()).collect::<Vec<_>>(),
    );
    let _ = app.emit(
        OUTPUT_EVENT,
        TunnelOutput {
            session_id,
            session_name,
            stream,
            level: line_level(line),
            line: scrubbed,
        },
    );
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

/// Which relay flag this tunnel gets, if any.
///
/// Extracted from `start_tunnel` purely so it can be tested: it is one line that decides the
/// carrier, and `start_tunnel` needs an `AppHandle`, so where it stood no test could reach it.
///
/// **`--force-relay` is passed alone, never alongside `--allow-relay`.** The jar sets
/// `allowRelay = true` (and pins `relayMode` to tcp) whenever `forceRelay` is set — read in
/// `PeerConnection`'s option handling rather than inferred from the flag names — so sending both
/// would be redundant rather than additive, and sending `--allow-relay` while meaning "force"
/// would silently give a direct connection instead.
fn relay_flag(config: &TunnelConfig) -> Option<&'static str> {
    if config.force_relay {
        Some("--force-relay")
    } else if config.allow_relay {
        Some("--allow-relay")
    } else {
        None
    }
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
    check_local_port(config.loreserver_port, PortRole::Loreserver)?;
    // The identity port needs the same check, and for a sharper reason: the registry test
    // above only sees *this app's* tunnels, so anything else on the machine holding it —
    // an ssh forward to the same host is the case that found this — got past both guards.
    // The tunnel then connected, failed to bind, and exited, which reads as "the connection
    // to the host ended" a minute later.
    if let Some(port) = config.identity_port {
        check_local_port(port, PortRole::Identity)?;
    }

    let jar = app
        .path()
        .resolve("alt-p2p-lore.jar", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("The bundled connection program is missing ({e})."))?;

    let mut args: Vec<String> = vec![
        // This stream is parsed, so its encoding is part of the protocol.
        //
        // Java sets `file.encoding` to UTF-8 but leaves `stdout.encoding` at the platform's
        // native charset, which on Windows is Cp1252 — so `--json` emits NDJSON that is not
        // UTF-8 the moment an event carries a non-ASCII character. Measured: `é` arrived as
        // the single byte `0xE9` and an em dash as `0x97`, both invalid UTF-8, which reaches
        // the webview as replacement characters and would mangle any accented path in a
        // tunnel event. Ordinary ASCII traffic hides it completely.
        //
        // Must precede `-jar`: everything after that is the program's own argv.
        "-Dstdout.encoding=UTF-8".into(),
        "-Dstderr.encoding=UTF-8".into(),
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
    if let Some(flag) = relay_flag(&config) {
        args.push(flag.into());
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
                        if !l.trim().is_empty() {
                            emit_output(&app_for_task, &id_for_task, "out", l.trim());
                        }
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
                        emit_output(&app_for_task, &id_for_task, "err", line);
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
                        // Say *what ended it* where the tunnel gave a reason. On its own this
                        // sentence describes the symptom the user has already noticed and
                        // nothing else; it was reported as unactionable for exactly that
                        // reason. The detail is appended, never substituted, because the first
                        // clause is the part a non-technical reader needs.
                        ended_reason(payload.code, &recent_stderr)
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
        TunnelEvent::TunnelReady { url, port: _, mode, peer } => {
            registry.set_ready(id, &url, mode.clone());
            emit(
                app,
                TunnelUpdate {
                    kind: UpdateKind::Ready,
                    id: id.into(),
                    phase: TunnelPhase::Connected,
                    detail: describe_route(&mode, peer.as_deref()),
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
/// How the connection was actually made, in a sentence.
///
/// "Connected" is three different outcomes wearing one word, and they perform nothing alike:
///
/// - **over the local network** — the peer is on this LAN, so the punch never left it. The
///   fastest route by a wide margin (118 MB/s against 19 MB/s on the same 2 GiB repository).
/// - **hole punched through NAT** — a genuine peer-to-peer link across the internet, which is
///   the thing alt-p2p exists to do.
/// - **through the relay** — working, but every byte goes via the coordinator.
///
/// The distinction is drawn from the peer's *address*, not from a claim the tunnel makes: a
/// private address means the far side is on this network. Absent — a relayed connection, or a
/// jar too old to report it — it degrades to plain "directly" rather than guessing.
pub fn describe_route(mode: &TunnelMode, peer: Option<&str>) -> String {
    if *mode == TunnelMode::Relay {
        return "Connected through the relay — slower than a direct connection.".to_string();
    }
    match peer.and_then(host_of) {
        Some(host) if is_local_network(&host) => {
            format!("Connected directly over the local network ({host}).")
        }
        Some(host) => format!("Connected directly, hole punched through NAT ({host})."),
        // Older jars send no peer address at all, so silence must not become a claim.
        None => "Connected directly.".to_string(),
    }
}

/// The host part of `addr:port`, tolerating IPv6's own colons.
fn host_of(peer: &str) -> Option<String> {
    let peer = peer.trim();
    if peer.is_empty() {
        return None;
    }
    // `[::1]:41234`
    if let Some(rest) = peer.strip_prefix('[') {
        return rest.split(']').next().map(|s| s.to_string());
    }
    // A bare IPv6 literal has several colons and no port; only split when there is exactly one.
    match peer.matches(':').count() {
        0 => Some(peer.to_string()),
        1 => peer.rsplit_once(':').map(|(h, _)| h.to_string()),
        _ => Some(peer.to_string()),
    }
}

/// Is this address on the local network rather than out on the internet?
pub fn is_local_network(host: &str) -> bool {
    // Strip a zone id (`fe80::1%en0`), which is not part of the address.
    let host = host.split('%').next().unwrap_or(host);
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local()
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            let s = v6.segments();
            // Unique-local (fc00::/7) and link-local (fe80::/10); both are unstable in std,
            // so they are spelled out rather than waiting for the API.
            v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
        // Not an address at all — a hostname, or something unexpected. Claiming either way
        // would be a guess.
        Err(_) => false,
    }
}

/// Which local listener a port is for. They fail the same way and are fixed differently.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PortRole {
    Loreserver,
    Identity,
}

/// Refuse a port that is already taken, before spending a process on it.
///
/// The child binds its listeners **last**, after connecting, so a busy port surfaces a minute
/// late and looks like a connection failure rather than a local one. Checking here turns that
/// into an immediate, specific refusal.
///
/// The two roles need different advice. A busy *loreserver* port is a free choice — any spare
/// port works. A busy *identity* port is not: the host's loreserver advertises its `auth_url`
/// (`[environment.endpoint].auth_url`), `lore` files tokens under that exact URL, and the port
/// is part of it. Telling someone to "pick another port" there sends them to invalidate their
/// own sign-in.
pub fn check_local_port(port: u16, role: PortRole) -> Result<(), String> {
    let Err(e) = std::net::TcpListener::bind(("127.0.0.1", port)) else {
        return Ok(());
    };
    Err(match role {
        PortRole::Loreserver => format!(
            "Local port {port} is not available ({e}). Another program on this machine is \
             using it — close it, or give this session a different local port."
        ),
        PortRole::Identity => format!(
            "Identity port {port} is already in use by another program on this machine ({e}). \
             This one cannot simply be changed: the host publishes it as its sign-in address \
             and your saved sign-in is filed under it. Close whatever is holding it — an ssh \
             forward to the same host will do this — and connect again."
        ),
    })
}

/// Why a *connected* tunnel ended.
///
/// "The connection to the host ended." is true, and by itself it is only the symptom the user
/// has already noticed — it was reported from testing as giving nothing to act on. Where the
/// tunnel said something recognisable, that is added; where it said something unrecognised,
/// its own last line is added; where it said nothing at all, the exit code at least
/// distinguishes a crash from a clean stop.
///
/// The opening sentence never changes, so the plain-language headline survives whatever
/// diagnostic follows it.
pub fn ended_reason(code: Option<i32>, stderr_tail: &[String]) -> String {
    const HEAD: &str = "The connection to the host ended.";

    // A known cause is worth more than any amount of raw log, and `explain_exit` already
    // recognises the ones that recur.
    if let Some(c) = code {
        let explained = explain_exit(c, stderr_tail);
        if !explained.starts_with("The connection program stopped unexpectedly") {
            return format!("{HEAD} {explained}");
        }
    }

    let last: Option<&String> = stderr_tail
        .iter()
        .rev()
        .find(|l| l.contains("ERROR") || l.contains("WARN") || l.contains("Exception"));
    let last = last.or_else(|| stderr_tail.last());

    match (last, code) {
        (Some(l), _) => format!("{HEAD} It last reported: {l}"),
        (None, Some(c)) if c != 0 => {
            format!("{HEAD} The connection program exited with code {c} and reported nothing.")
        }
        // Turn on debug messages in Settings and the tunnel's own output is in the console.
        _ => format!("{HEAD} It reported nothing — switch on debug messages to see its output."),
    }
}

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
    use super::{friendly_error, relay_flag, TunnelConfig};

    fn cfg(allow_relay: bool, force_relay: bool) -> TunnelConfig {
        TunnelConfig {
            session_name: "n".into(),
            session_id: "s".into(),
            psk: "k".into(),
            server: "h:1".into(),
            loreserver_port: 41400,
            identity_port: None,
            allow_relay,
            force_relay,
        }
    }

    #[test]
    fn force_relay_is_passed_alone_never_alongside_allow() {
        // The jar sets allowRelay itself when forceRelay is set, so passing both is redundant.
        // Asserted because "push both to be safe" is the obvious wrong instinct here.
        assert_eq!(relay_flag(&cfg(true, true)), Some("--force-relay"));
    }

    #[test]
    fn force_relay_wins_over_a_cleared_allow_relay() {
        // The UI cannot produce this pair — it disables the allow box when force is on — but a
        // hand-edited config can, and "force, but relay not allowed" must not silently become a
        // direct connection, which is the exact carrier the user asked to avoid.
        assert_eq!(relay_flag(&cfg(false, true)), Some("--force-relay"));
    }

    #[test]
    fn allow_relay_alone_is_unchanged_by_the_new_option() {
        assert_eq!(relay_flag(&cfg(true, false)), Some("--allow-relay"));
    }

    #[test]
    fn neither_flag_when_both_are_off() {
        assert_eq!(relay_flag(&cfg(false, false)), None);
    }

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
