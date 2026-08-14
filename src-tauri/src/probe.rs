//! Is a host answering?
//!
//! A **P2P** host has a tunnel process whose phase already answers this. A **direct** host has
//! nothing to watch — it is an address that either answers or does not — and until now the UI
//! simply assumed it did, showing a green dot for a machine that could be switched off. That
//! is the one thing this app is not allowed to do: green is what lets somebody start a long
//! push, so a green light it cannot justify is worse than no light.
//!
//! A TCP connect, deliberately, rather than a `lore` call:
//!
//! - it costs no process and no repository, so it can run on a timer for every host;
//! - it needs no identity, so it works against a host nobody is signed in to;
//! - it distinguishes the two failures that matter for the *user's* next action — refused
//!   (something is there saying no, or nothing is listening) against timed out (the machine is
//!   asleep or gone), which fail in 0.2s and several seconds respectively.
//!
//! What it deliberately does **not** claim: that loreserver is healthy, or that this identity
//! may do anything. An open port is evidence the machine is up and something is listening,
//! and that is exactly what the dot means.

use serde::Serialize;
use std::time::Duration;

/// How long to wait before calling a host unreachable.
///
/// Short on purpose: this runs on a timer, and a probe that outlives its own interval would
/// pile up. A refusal returns far faster than this — measured at 0.2s against a stopped
/// loreserver on the LAN — so the budget is really for the sleeping case, where nothing
/// answers at all.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostProbe {
    /// Something accepted a connection on that port.
    Up,
    /// Nothing is listening: the machine is reachable and the service is not running.
    Refused,
    /// Nothing answered at all — asleep, gone, or filtered.
    Unreachable,
    /// The address could not be understood, so there is nothing to probe.
    Bad,
}

/// Split `grpc://host:port/whatever` into a host and port.
///
/// Written by hand rather than with a URL crate because the input is one of ours — a base URL
/// this app composed — and the failure mode of a parser here is the whole probe going quiet.
pub fn authority_of(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }
    // IPv6 literals are bracketed, and splitting those on ':' would sever the address.
    if let Some(stripped) = authority.strip_prefix('[') {
        let (host, tail) = stripped.split_once(']')?;
        let port = tail.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), port));
    }
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

/// Probe one host.
#[tauri::command]
pub async fn probe_host(url: String) -> HostProbe {
    let Some((host, port)) = authority_of(&url) else {
        return HostProbe::Bad;
    };

    // Resolution and connection both happen on a blocking thread: a name that does not resolve
    // can take seconds, and the async runtime is also carrying the UI's other commands.
    let result = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let addrs: Vec<_> = (host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect())
            .unwrap_or_default();
        if addrs.is_empty() {
            return HostProbe::Unreachable;
        }
        for addr in addrs {
            match std::net::TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
                Ok(_) => return HostProbe::Up,
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    return HostProbe::Refused
                }
                // Try the next address: a host with both A and AAAA records may answer on
                // only one of them, and giving up on the first would report a live host down.
                Err(_) => continue,
            }
        }
        HostProbe::Unreachable
    })
    .await;

    result.unwrap_or(HostProbe::Unreachable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_authority_out_of_a_base_url() {
        assert_eq!(authority_of("grpc://192.168.1.20:41337"), Some(("192.168.1.20".into(), 41337)));
        assert_eq!(
            authority_of("grpc://127.0.0.1:41400/019f9e"),
            Some(("127.0.0.1".into(), 41400))
        );
        assert_eq!(authority_of("https://lore.example:9443/"), Some(("lore.example".into(), 9443)));
    }

    #[test]
    fn does_not_sever_an_ipv6_literal() {
        // rsplit_once(':') on a bare IPv6 address would take the last group as a port.
        assert_eq!(authority_of("grpc://[fd00::1]:41337"), Some(("fd00::1".into(), 41337)));
    }

    #[test]
    fn refuses_what_it_cannot_understand_instead_of_guessing() {
        // No port means no probe: inventing 443 or 80 would report some *other* service up.
        assert_eq!(authority_of("grpc://192.168.1.20"), None);
        assert_eq!(authority_of(""), None);
        assert_eq!(authority_of("grpc://"), None);
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn an_unparseable_url_is_bad_not_unreachable() {
        // The two mean different things to the user: one is a typo in their own settings,
        // the other is somebody else's machine being off.
        assert_eq!(block_on(probe_host("not a url".into())), HostProbe::Bad);
    }

    #[test]
    fn a_closed_port_is_refused_not_unreachable() {
        // Distinguishing these is the point: "nothing is listening there" sends you to start
        // the service, "nothing answered" sends you to look at the machine.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(block_on(probe_host(format!("grpc://127.0.0.1:{port}"))), HostProbe::Refused);
    }

    #[test]
    fn a_listening_port_is_up() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(block_on(probe_host(format!("grpc://127.0.0.1:{port}"))), HostProbe::Up);
    }
}
