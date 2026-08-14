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
            TunnelEvent::TunnelReady { url, port, mode } => Some((url.clone(), *port, mode.clone())),
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
use alt_p2p_lore_ui_lib::tunnel::supervisor::explain_exit;

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
