//! Events emitted by `alt-p2p-lore connect --json`.
//!
//! One JSON object per line on stdout. Unlike the `lore` CLI, this *is* a machine-readable
//! interface — but it is still a contract with a separately-versioned program, so the same
//! discipline applies: parse defensively, pin the shapes with fixtures captured from real
//! runs, and never let an unrecognised line be fatal.
//!
//! Observed vocabulary (captured 2026-08-13 against ctone, alt-p2p-lore 0.4.1):
//!
//! ```text
//! direct : registering → waiting_peer → punching → handshaking → connected
//!          tunnel_ready {url, port, mode:"direct"}
//! relay  : registering → waiting_peer → punching → relay_tcp   → connected
//!          tunnel_ready {url, port, mode:"relay"}
//! failure: registering → error
//!          error {message}
//! ```

use serde::{Deserialize, Serialize};

/// Connection phase, as the tunnel reports it.
///
/// `Other` exists because this program ships separately from the app: a future alt-p2p
/// could add a phase, and treating that as a crash — or worse, as "connected" — would be a
/// self-inflicted outage. An unknown phase is shown as progress and nothing more.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelPhase {
    Registering,
    WaitingPeer,
    Punching,
    Handshaking,
    /// Falling back through the coordinator's TCP relay.
    RelayTcp,
    /// UDP relay, the older fallback.
    Relaying,
    Connected,
    Error,
    /// Stopped because someone asked it to.
    ///
    /// Not a phase the tunnel ever reports — it is set locally when the user disconnects.
    /// Kept apart from `Error` because the two look identical from the process's point of
    /// view (a killed child exits non-zero) and completely different from the user's: one
    /// is something that went wrong, the other is what they just clicked. Folding them
    /// together left a deliberately closed session sitting red with "the connection program
    /// stopped" in the feed.
    Stopped,
    #[serde(other)]
    Other,
}

impl TunnelPhase {
    /// Wording for the UI. Plain, and honest about what is degraded.
    pub fn describe(&self) -> &'static str {
        match self {
            TunnelPhase::Registering => "Registering with the coordinator…",
            TunnelPhase::WaitingPeer => "Waiting for the host…",
            TunnelPhase::Punching => "Finding a direct route…",
            TunnelPhase::Handshaking => "Securing the connection…",
            // Named rather than hidden: it works, but it is slower, and knowing that
            // explains the difference instead of leaving the user to wonder.
            TunnelPhase::RelayTcp | TunnelPhase::Relaying => "Connecting through the relay…",
            TunnelPhase::Connected => "Connected",
            TunnelPhase::Error => "Failed",
            TunnelPhase::Stopped => "Disconnected",
            TunnelPhase::Other => "Working…",
        }
    }

    /// True once the tunnel can carry traffic.
    pub fn is_connected(&self) -> bool {
        matches!(self, TunnelPhase::Connected)
    }
}

/// How the connection is carried. A relay works but is slower.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelMode {
    Direct,
    Relay,
    #[serde(other)]
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TunnelEvent {
    Status {
        state: TunnelPhase,
    },
    TunnelReady {
        url: String,
        port: u16,
        mode: TunnelMode,
    },
    Error {
        message: String,
    },
    /// Anything we do not recognise. Kept rather than dropped so it can be logged.
    #[serde(other)]
    Unknown,
}

/// Parse one line of the tunnel's stdout.
///
/// Returns `None` for blank lines, log noise, or malformed JSON. The tunnel writes its
/// human logs to stderr, but a stray line on stdout must not take the supervisor down —
/// this is the boundary with a process we do not control.
pub fn parse_line(line: &str) -> Option<TunnelEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<TunnelEvent>(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_status_line() {
        let e = parse_line(r#"{"event":"status","state":"punching"}"#).unwrap();
        assert_eq!(e, TunnelEvent::Status { state: TunnelPhase::Punching });
    }

    #[test]
    fn reads_tunnel_ready_with_its_mode() {
        let e = parse_line(
            r#"{"event":"tunnel_ready","url":"grpc://127.0.0.1:41500","port":41500,"mode":"direct"}"#,
        )
        .unwrap();
        match e {
            TunnelEvent::TunnelReady { url, port, mode } => {
                assert_eq!(url, "grpc://127.0.0.1:41500");
                assert_eq!(port, 41500);
                assert_eq!(mode, TunnelMode::Direct);
            }
            other => panic!("expected tunnel_ready, got {other:?}"),
        }
    }

    #[test]
    fn reads_an_error() {
        let e = parse_line(r#"{"event":"error","message":"Authentication failed"}"#).unwrap();
        assert_eq!(e, TunnelEvent::Error { message: "Authentication failed".into() });
    }

    #[test]
    fn an_unknown_phase_is_progress_not_a_crash() {
        // alt-p2p ships separately. A phase added there must not take this app down, and
        // must certainly not be mistaken for "connected".
        let e = parse_line(r#"{"event":"status","state":"quantum_entangling"}"#).unwrap();
        assert_eq!(e, TunnelEvent::Status { state: TunnelPhase::Other });
        assert!(!TunnelPhase::Other.is_connected());
    }

    #[test]
    fn an_unknown_event_type_is_kept_not_fatal() {
        let e = parse_line(r#"{"event":"something_new","detail":1}"#).unwrap();
        assert_eq!(e, TunnelEvent::Unknown);
    }

    #[test]
    fn log_noise_on_stdout_is_ignored() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("[main] INFO something happened").is_none());
        assert!(parse_line("{not valid json").is_none());
    }

    #[test]
    fn only_connected_counts_as_connected() {
        for p in [
            TunnelPhase::Registering,
            TunnelPhase::WaitingPeer,
            TunnelPhase::Punching,
            TunnelPhase::Handshaking,
            TunnelPhase::RelayTcp,
            TunnelPhase::Error,
            TunnelPhase::Other,
        ] {
            assert!(!p.is_connected(), "{p:?} must not read as connected");
        }
        assert!(TunnelPhase::Connected.is_connected());
    }

    #[test]
    fn every_phase_has_wording() {
        for p in [
            TunnelPhase::Registering,
            TunnelPhase::WaitingPeer,
            TunnelPhase::Punching,
            TunnelPhase::Handshaking,
            TunnelPhase::RelayTcp,
            TunnelPhase::Relaying,
            TunnelPhase::Connected,
            TunnelPhase::Error,
            TunnelPhase::Other,
        ] {
            assert!(!p.describe().is_empty(), "{p:?} has no description");
        }
    }
}
