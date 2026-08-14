//! Golden tests for tunnel events, against NDJSON captured from real connections.
//!
//! The three fixtures are complete runs recorded on 2026-08-13 against ctone: a direct
//! connection, a relayed one (`--force-relay`), and an authentication failure (wrong PSK).
//! Replaying whole sequences rather than single lines is deliberate — the bugs that matter
//! here are about *order and terminal state*, not about parsing one object.

use alt_p2p_lore_ui_lib::tunnel::event::*;

fn replay(name: &str) -> Vec<TunnelEvent> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()));
    text.lines().filter_map(parse_line).collect()
}

fn phases(events: &[TunnelEvent]) -> Vec<TunnelPhase> {
    events
        .iter()
        .filter_map(|e| match e {
            TunnelEvent::Status { state } => Some(state.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_direct_connection_runs_through_to_connected() {
    let events = replay("tunnel_direct.ndjson");
    assert_eq!(
        phases(&events),
        vec![
            TunnelPhase::Registering,
            TunnelPhase::WaitingPeer,
            TunnelPhase::Punching,
            TunnelPhase::Handshaking,
            TunnelPhase::Connected,
        ]
    );

    let ready = events
        .iter()
        .find_map(|e| match e {
            TunnelEvent::TunnelReady { url, port, mode, .. } => Some((url.clone(), *port, mode.clone())),
            _ => None,
        })
        .expect("a direct connection ends with tunnel_ready");
    assert_eq!(ready.1, 41500);
    assert_eq!(ready.2, TunnelMode::Direct);
    assert!(ready.0.starts_with("grpc://"), "the url is what lore is pointed at");
}

#[test]
fn a_relayed_connection_reports_relay_and_still_connects() {
    let events = replay("tunnel_relay.ndjson");
    let p = phases(&events);

    // The distinguishing phase: punching is attempted, then it falls back.
    assert!(p.contains(&TunnelPhase::RelayTcp), "relay run should report relay_tcp");
    assert!(!p.contains(&TunnelPhase::Handshaking), "the relay path does not report handshaking");
    assert_eq!(p.last(), Some(&TunnelPhase::Connected));

    let mode = events.iter().find_map(|e| match e {
        TunnelEvent::TunnelReady { mode, .. } => Some(mode.clone()),
        _ => None,
    });
    // Mode is what tells the UI to warn that transfers will be slower.
    assert_eq!(mode, Some(TunnelMode::Relay));
}

#[test]
fn an_authentication_failure_ends_in_error_with_a_reason() {
    let events = replay("tunnel_auth_failure.ndjson");

    assert_eq!(phases(&events).last(), Some(&TunnelPhase::Error));
    assert!(
        !events.iter().any(|e| matches!(e, TunnelEvent::TunnelReady { .. })),
        "a failed connection must never report a ready tunnel"
    );

    let msg = events
        .iter()
        .find_map(|e| match e {
            TunnelEvent::Error { message } => Some(message.clone()),
            _ => None,
        })
        .expect("a failure carries a reason");
    assert!(
        msg.to_lowercase().contains("authentication"),
        "the reason should name the cause, got: {msg}"
    );
}

#[test]
fn no_fixture_reports_connected_before_it_is() {
    // Guards the ordering the UI depends on: nothing may claim connectivity before the
    // phase that grants it. A tab turning green early is worse than one turning green late.
    for name in ["tunnel_direct.ndjson", "tunnel_relay.ndjson", "tunnel_auth_failure.ndjson"] {
        let events = replay(name);
        let p = phases(&events);
        if let Some(i) = p.iter().position(|x| *x == TunnelPhase::Connected) {
            assert_eq!(i, p.len() - 1, "{name}: connected should be the final phase");
        }
        if let Some(ready) = events.iter().position(|e| matches!(e, TunnelEvent::TunnelReady { .. })) {
            let connected = events
                .iter()
                .position(|e| matches!(e, TunnelEvent::Status { state } if state.is_connected()))
                .expect("ready implies connected");
            assert!(connected < ready, "{name}: connected must precede tunnel_ready");
        }
    }
}

#[test]
fn every_fixture_parses_completely() {
    // If a real capture contains a line we cannot read, the vocabulary has moved and the
    // supervisor is working from a partial picture.
    for name in ["tunnel_direct.ndjson", "tunnel_relay.ndjson", "tunnel_auth_failure.ndjson"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        let text = std::fs::read_to_string(path).unwrap();
        let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
        let parsed = replay(name).len();
        assert_eq!(parsed, lines, "{name}: {} of {lines} lines parsed", parsed);
        assert!(
            !replay(name).contains(&TunnelEvent::Unknown),
            "{name}: contains an event shape we do not recognise"
        );
    }
}

// --- registry selection ----------------------------------------------------
// These use the registry directly rather than the event stream: the bug was in which row
// was chosen, not in how events were read.

use alt_p2p_lore_ui_lib::registry::Registry;
use alt_p2p_lore_ui_lib::tunnel::supervisor::{
    check_local_port, describe_route, ended_reason, explain_exit, is_local_network, line_level,
    PortRole,
};

#[test]
fn a_session_with_no_tunnel_has_none() {
    let r = Registry::default();
    assert!(r.for_session("nothing").is_none());
}

// --- explaining a bare exit code -------------------------------------------
// Reported from testing: "it says the connection program exited with code 1, but doesn't
// show any info the user can act on." The exit code is not the information — the tunnel's
// stderr is, and it was being discarded.

#[test]
fn a_busy_port_is_named_as_a_busy_port() {
    let msg = explain_exit(
        1,
        &["java.net.BindException: Address already in use".to_string()],
    );
    assert!(msg.contains("already in use"), "got {msg}");
    assert!(msg.contains("local port"), "it should say which setting to change: {msg}");
}

#[test]
fn an_unknown_coordinator_host_is_named() {
    let msg = explain_exit(1, &["java.net.UnknownHostException: nope.example".to_string()]);
    assert!(msg.to_lowercase().contains("coordinator address"), "got {msg}");
}

#[test]
fn a_refused_coordinator_is_named() {
    let msg = explain_exit(1, &["Connection refused".to_string()]);
    assert!(msg.to_lowercase().contains("refused"), "got {msg}");
}

#[test]
fn an_unrecognised_failure_still_quotes_what_the_tunnel_said() {
    // The point of the fix: never leave the user with a number alone.
    let msg = explain_exit(1, &["Something specific and unexpected".to_string()]);
    assert!(msg.contains("Something specific and unexpected"), "got {msg}");
    assert!(msg.contains("exit code 1"));
}

#[test]
fn a_silent_failure_says_so_rather_than_inventing_a_cause() {
    let msg = explain_exit(3, &[]);
    assert!(msg.contains("exit code 3"));
    assert!(msg.contains("stopped unexpectedly"));
}

#[test]
fn only_the_last_few_stderr_lines_are_quoted() {
    // A stack trace pasted whole into a notification is unreadable.
    let noisy: Vec<String> = (0..30).map(|i| format!("line{i}")).collect();
    let msg = explain_exit(1, &noisy);
    assert!(msg.contains("line29"), "the most recent line matters most: {msg}");
    assert!(!msg.contains("line0"), "the whole log must not be dumped: {msg}");
}

/// What a *connected* tunnel says when it drops.
///
/// Reported from testing: connecting to `session_main` produced "The connection to the host
/// ended." and nothing else — true, and identical to the symptom the user had already noticed.
/// The headline stays, because it is the part a non-technical reader needs; the cause is added.
mod ended {
    use super::ended_reason;

    #[test]
    fn keeps_the_plain_headline_whatever_follows_it() {
        for msg in [
            ended_reason(Some(1), &["ERROR Session full".to_string()]),
            ended_reason(Some(0), &[]),
            ended_reason(None, &[]),
        ] {
            assert!(msg.starts_with("The connection to the host ended."), "{msg}");
        }
    }

    #[test]
    fn prefers_a_cause_it_recognises_over_raw_log() {
        let msg = ended_reason(Some(1), &["java.net.BindException: Address already in use".to_string()]);
        assert!(msg.contains("already in use"), "{msg}");
        // The recogniser's advice, not a stack trace.
        assert!(msg.contains("different local port"), "{msg}");
    }

    #[test]
    fn quotes_the_tunnels_own_last_error_when_nothing_is_recognised() {
        let msg = ended_reason(
            Some(1),
            &[
                "INFO Connected to coordinator".to_string(),
                "ERROR Peer went away unexpectedly".to_string(),
                "INFO Shutting down".to_string(),
            ],
        );
        // The *error* line, not merely the last line — the last is usually a shutdown notice.
        assert!(msg.contains("Peer went away unexpectedly"), "{msg}");
    }

    #[test]
    fn falls_back_to_the_last_line_when_none_is_an_error() {
        let msg = ended_reason(Some(1), &["INFO Peer closed the session".to_string()]);
        assert!(msg.contains("Peer closed the session"), "{msg}");
    }

    #[test]
    fn says_where_to_look_when_the_tunnel_said_nothing_at_all() {
        // Silence is the case that produced the original complaint, so it must not end here.
        let msg = ended_reason(None, &[]);
        assert!(msg.contains("debug"), "{msg}");
    }

    #[test]
    fn names_the_exit_code_when_that_is_all_there_is() {
        let msg = ended_reason(Some(137), &[]);
        assert!(msg.contains("137"), "{msg}");
    }
}

mod levels {
    use super::line_level;

    #[test]
    fn reads_severity_from_the_line_not_the_stream() {
        // Java logs everything to stderr; treating the stream as severity would paint an
        // ordinary connection red from end to end.
        assert_eq!(line_level("INFO Punching to 1.2.3.4"), "info");
        assert_eq!(line_level("WARN Falling back to relay"), "warn");
        assert_eq!(line_level("ERROR Session full"), "error");
        // A thrown exception counts, however it is spelled — that is what puts a stack trace
        // under Problems, which is where somebody chasing a dropped connection will look.
        assert_eq!(line_level("java.net.SocketException: closed"), "error");
        assert_eq!(line_level("Caused by: java.io.IOException"), "error");
        // And an ordinary line stays quiet, so the colour keeps meaning something.
        assert_eq!(line_level("Hole punch succeeded in 412ms"), "info");
    }
}

/// Refusing a busy port up front.
///
/// Found live: an ssh forward to the same host held the identity port, so the tunnel connected,
/// failed to bind, and exited — reported as "The connection to the host ended", a minute after
/// the actual fault. The loreserver port was already pre-flighted; the identity port was only
/// checked against this app's own registry, which cannot see another program.
mod ports {
    use super::{check_local_port, PortRole};
    use std::net::TcpListener;

    #[test]
    fn a_free_port_is_accepted() {
        // Bind, read the port, drop — a port the OS just handed out is free.
        let port = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert!(check_local_port(port, PortRole::Identity).is_ok());
        assert!(check_local_port(port, PortRole::Loreserver).is_ok());
    }

    #[test]
    fn a_port_held_by_another_program_is_refused() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(check_local_port(port, PortRole::Identity).is_err());
        assert!(check_local_port(port, PortRole::Loreserver).is_err());
    }

    #[test]
    fn the_identity_port_is_not_described_as_a_free_choice() {
        // The advice differs by role, and getting this wrong is harmful rather than merely
        // unhelpful: the host publishes the identity port as its sign-in address and `lore`
        // files tokens under that URL, so "pick another port" invalidates the sign-in.
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();

        let identity = check_local_port(port, PortRole::Identity).unwrap_err();
        assert!(!identity.contains("different local port"), "{identity}");
        assert!(identity.contains("sign-in"), "{identity}");

        let loreserver = check_local_port(port, PortRole::Loreserver).unwrap_err();
        assert!(loreserver.contains("different local port"), "{loreserver}");
    }

    #[test]
    fn the_refusal_names_the_port() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(check_local_port(port, PortRole::Identity).unwrap_err().contains(&port.to_string()));
    }
}

/// How the connection was made — LAN, hole punch, or relay.
///
/// "Connected" covers three outcomes that perform nothing alike: the same 2 GiB repository
/// cloned in 16s over the LAN and 100s through the tunnel. The route is read from the peer's
/// address rather than claimed.
mod route {
    use super::{describe_route, is_local_network};
    use alt_p2p_lore_ui_lib::tunnel::event::TunnelMode;

    #[test]
    fn a_peer_on_this_network_is_named_as_local() {
        let msg = describe_route(&TunnelMode::Direct, Some("192.168.1.10:41234"));
        assert!(msg.contains("local network"), "{msg}");
        assert!(msg.contains("192.168.1.10"), "the address is worth showing: {msg}");
    }

    #[test]
    fn a_public_peer_is_named_as_a_punch_through_nat() {
        let msg = describe_route(&TunnelMode::Direct, Some("203.0.113.7:41234"));
        assert!(msg.contains("hole punched"), "{msg}");
        assert!(!msg.contains("local network"), "{msg}");
    }

    #[test]
    fn the_relay_is_never_described_as_direct() {
        // The relay path has no peer address — the socket is connected to the coordinator —
        // but even if one were supplied it must not be read as a direct link.
        for peer in [None, Some("192.168.1.10:41234")] {
            let msg = describe_route(&TunnelMode::Relay, peer);
            assert!(msg.contains("relay"), "{msg}");
            assert!(!msg.contains("local network"), "{msg}");
        }
    }

    #[test]
    fn an_older_jar_that_sends_no_peer_gets_no_invented_route() {
        // Wire compatibility: the field is new. Silence must degrade to "directly", never to
        // a claim about a route nobody reported.
        let msg = describe_route(&TunnelMode::Direct, None);
        assert_eq!(msg, "Connected directly.");
    }

    #[test]
    fn every_private_range_counts_as_local() {
        for host in ["10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.10", "127.0.0.1", "169.254.1.1"] {
            assert!(is_local_network(host), "{host} should be local");
        }
        // 172.32 is outside the /12 — the classic off-by-one in this check.
        for host in ["8.8.8.8", "203.0.113.7", "172.32.0.1", "11.0.0.1"] {
            assert!(!is_local_network(host), "{host} should not be local");
        }
    }

    #[test]
    fn ipv6_is_classified_too() {
        assert!(is_local_network("::1"));
        assert!(is_local_network("fd00::1"));
        assert!(is_local_network("fe80::1%en0"), "a zone id is not part of the address");
        assert!(!is_local_network("2001:4860:4860::8888"));
    }

    #[test]
    fn an_ipv6_peer_is_split_on_the_right_colon() {
        // `rsplit_once(':')` on a bare IPv6 literal would sever the address itself.
        let msg = describe_route(&TunnelMode::Direct, Some("[fd00::1]:41234"));
        assert!(msg.contains("local network"), "{msg}");
    }

    #[test]
    fn a_hostname_is_not_guessed_at() {
        let msg = describe_route(&TunnelMode::Direct, Some("ctone.local:41234"));
        assert!(msg.contains("hole punched"), "unresolvable is not local: {msg}");
    }
}
