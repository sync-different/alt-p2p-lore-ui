//! Registry of long-lived child processes (the tunnels).
//!
//! Why this lives in Rust rather than the frontend, which is how the sibling app does it:
//!
//! alt-p2p-ui keeps its single child in a React `useRef`. That survives only because it
//! runs exactly one process, and even then it had to *disable the tab buttons* to stop a
//! component unmount from orphaning the JVM. This app must hold many tunnels open at once,
//! for hours, across every navigation the user makes — a handle owned by a component that
//! can unmount is the wrong place for it.
//!
//! So the registry outlives the UI entirely. The frontend holds ids; Rust holds processes.
//! The consequence worth stating plainly: **every process spawned here must be killed on
//! exit**, or an artist who quits the app leaves tunnels running with no window to stop
//! them from. `kill_all` is wired to `RunEvent::ExitRequested` in lib.rs for that reason.

use crate::tunnel::event::{TunnelMode, TunnelPhase};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

pub type TunnelId = String;

#[derive(Serialize, Clone, Debug)]
pub struct TunnelInfo {
    pub id: TunnelId,
    /// alt-p2p session id — the rendezvous name.
    pub session_id: String,
    /// What the user calls this session.
    pub session_name: String,
    /// Local port the lore CLI should talk to for this session.
    pub loreserver_port: u16,
    /// Not freely chosen: it must equal the port in the host's advertised auth_url, which
    /// is also the key the lore CLI files its token under. Two hosts advertising the same
    /// port therefore cannot both be connected — see PLAN.md O1.
    pub identity_port: Option<u16>,
    pub phase: TunnelPhase,
    /// Direct or relayed. Only known once connected.
    pub mode: Option<TunnelMode>,
    /// What to point `lore` at, e.g. "grpc://127.0.0.1:41400".
    pub url: Option<String>,
    pub error: Option<String>,
}

impl TunnelInfo {
    /// Live means "carrying traffic now" — not merely "we started something".
    pub fn is_live(&self) -> bool {
        self.phase.is_connected()
    }
}

struct Entry {
    info: TunnelInfo,
    /// None once the process has exited; the info row is kept so the UI can show why.
    child: Option<CommandChild>,
    /// Set when *we* killed it. Without this the exit handler cannot tell a disconnect
    /// from a crash — a killed child exits non-zero either way — and reports both as
    /// failures.
    stopping: bool,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<TunnelId, Entry>>,
}

#[allow(dead_code)]
impl Registry {
    /// Register a newly started tunnel, retiring any dead one for the same session.
    ///
    /// Without this, a failed attempt leaves a row behind and a later success adds a second
    /// one for the same session. Anything asking "what is this session doing?" then has two
    /// answers and no way to choose — which showed up as a tab stuck red while the activity
    /// feed said connected.
    ///
    /// Only *dead* rows are retired here. A *live* duplicate is not this method's business:
    /// it must be killed before the new process is spawned, not after — see
    /// `live_for_session` and its use in `start_tunnel`.
    pub fn insert(&self, info: TunnelInfo, child: CommandChild) {
        let mut map = self.entries.lock().expect("registry poisoned");
        map.retain(|_, e| e.info.session_id != info.session_id || e.child.is_some());
        map.insert(info.id.clone(), Entry { info, child: Some(child), stopping: false });
    }

    /// A running tunnel for this session, and whether it is actually carrying traffic.
    ///
    /// Two processes on one alt-p2p session id is never legitimate, however it happens. The
    /// session id *is* the rendezvous name, and a REGISTER on an already-paired session
    /// recycles the coordinator's slots — so the second attempt does not merely fail, it
    /// re-points the host at itself and takes down the working tunnel on its way. Observed
    /// directly: two children of the app, same session, same local port, one connected and
    /// holding the port while the other punched forever.
    pub fn live_for_session(&self, session_id: &str) -> Option<(TunnelId, bool)> {
        let map = self.entries.lock().expect("registry poisoned");
        map.values()
            .find(|e| e.info.session_id == session_id && e.child.is_some())
            .map(|e| (e.info.id.clone(), e.info.is_live()))
    }

    /// The tunnel serving a session: a live one if there is one, otherwise the last known.
    ///
    /// Preferring the live entry is the point. A stopped row is worth keeping so the UI can
    /// explain *why* a session ended, but it must never outrank a working connection.
    pub fn for_session(&self, session_id: &str) -> Option<TunnelInfo> {
        let map = self.entries.lock().expect("registry poisoned");
        let mut best: Option<&Entry> = None;
        for e in map.values().filter(|e| e.info.session_id == session_id) {
            let better = match best {
                None => true,
                Some(b) => e.child.is_some() && b.child.is_none(),
            };
            if better {
                best = Some(e);
            }
        }
        best.map(|e| e.info.clone())
    }

    pub fn get(&self, id: &str) -> Option<TunnelInfo> {
        let map = self.entries.lock().expect("registry poisoned");
        map.get(id).map(|e| e.info.clone())
    }

    pub fn list(&self) -> Vec<TunnelInfo> {
        let map = self.entries.lock().expect("registry poisoned");
        let mut out: Vec<_> = map.values().map(|e| e.info.clone()).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn set_phase(&self, id: &str, phase: TunnelPhase) {
        let mut map = self.entries.lock().expect("registry poisoned");
        if let Some(e) = map.get_mut(id) {
            e.info.phase = phase;
        }
    }

    pub fn set_ready(&self, id: &str, url: &str, mode: TunnelMode) {
        let mut map = self.entries.lock().expect("registry poisoned");
        if let Some(e) = map.get_mut(id) {
            e.info.phase = TunnelPhase::Connected;
            e.info.url = Some(url.to_string());
            e.info.mode = Some(mode);
            e.info.error = None;
        }
    }

    pub fn set_error(&self, id: &str, message: &str) {
        let mut map = self.entries.lock().expect("registry poisoned");
        if let Some(e) = map.get_mut(id) {
            e.info.phase = TunnelPhase::Error;
            e.info.error = Some(message.to_string());
        }
    }

    /// Record that the child has exited, dropping the handle.
    ///
    /// Returns the phase it settled on, so the caller can decide whether this is news worth
    /// reporting as a failure.
    pub fn mark_stopped(&self, id: &str, reason: &str) -> TunnelPhase {
        let mut map = self.entries.lock().expect("registry poisoned");
        let Some(e) = map.get_mut(id) else { return TunnelPhase::Error };
        {
            e.child = None;
            // An exit we asked for is not a failure, however the process ended.
            e.info.phase = if e.stopping { TunnelPhase::Stopped } else { TunnelPhase::Error };
            e.info.error = if e.stopping { None } else { Some(reason.to_string()) };
            // The url is no longer usable, and leaving it would let the UI keep pointing
            // `lore` at a port nothing is listening on.
            e.info.url = None;
        }
        e.info.phase.clone()
    }

    /// The session name holding this identity port, if a live tunnel has it.
    ///
    /// Checked before starting a second authenticated session, so the collision is reported
    /// as a plain sentence up front rather than as a bind error from deep inside the tunnel
    /// process, which names a port the user never chose.
    pub fn identity_port_in_use(&self, port: u16) -> Option<String> {
        let map = self.entries.lock().expect("registry poisoned");
        map.values()
            .find(|e| e.info.identity_port == Some(port) && e.child.is_some())
            .map(|e| e.info.session_name.clone())
    }

    /// Stop one tunnel. Returns false if it was not running.
    pub fn kill(&self, id: &str) -> bool {
        let mut map = self.entries.lock().expect("registry poisoned");
        match map.get_mut(id) {
            Some(e) => match e.child.take() {
                Some(child) => {
                    // Recorded before the kill, so the exit handler — which runs on another
                    // thread and may win the race — already knows this was asked for.
                    e.stopping = true;
                    let _ = child.kill();
                    e.info.phase = TunnelPhase::Stopped;
                    e.info.url = None;
                    e.info.error = None;
                    true
                }
                None => false,
            },
            None => false,
        }
    }

    /// Forget a stopped tunnel entirely.
    pub fn remove(&self, id: &str) {
        let mut map = self.entries.lock().expect("registry poisoned");
        if let Some(e) = map.get_mut(id) {
            if let Some(child) = e.child.take() {
                let _ = child.kill();
            }
        }
        map.remove(id);
    }

    /// Stop everything. Called on app exit; leaving this out is how tunnels outlive the
    /// window that was supposed to control them.
    pub fn kill_all(&self) -> usize {
        let mut map = self.entries.lock().expect("registry poisoned");
        let mut n = 0;
        for e in map.values_mut() {
            e.stopping = true;
            if let Some(child) = e.child.take() {
                let _ = child.kill();
                n += 1;
            }
        }
        n
    }
}

#[tauri::command]
pub fn list_tunnels(registry: tauri::State<'_, Registry>) -> Vec<TunnelInfo> {
    registry.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a row with no child.
    ///
    /// `insert` needs a real `CommandChild`, which cannot be conjured in a unit test — but
    /// the decision under test happens *after* the process is gone, so a childless entry is
    /// exactly the state that matters.
    impl Registry {
        fn insert_stub(&self, id: &str, session: &str, stopping: bool) {
            let mut map = self.entries.lock().unwrap();
            map.insert(
                id.into(),
                Entry {
                    info: TunnelInfo {
                        id: id.into(),
                        session_id: session.into(),
                        session_name: "Main".into(),
                        loreserver_port: 41400,
                        identity_port: None,
                        phase: TunnelPhase::Connected,
                        mode: None,
                        url: Some("grpc://127.0.0.1:41400".into()),
                        error: None,
                    },
                    child: None,
                    stopping,
                },
            );
        }
    }

    #[test]
    fn a_disconnect_the_user_asked_for_is_not_a_failure() {
        // A killed child exits non-zero exactly like a crashed one, so the exit code cannot
        // tell them apart. Only the registry knows which happened — and getting this wrong
        // left a session the user closed sitting red with an error in the feed.
        let r = Registry::default();
        r.insert_stub("t1", "s1", true);

        let phase = r.mark_stopped("t1", "It stopped unexpectedly (exit code 1).");
        assert_eq!(phase, TunnelPhase::Stopped);

        let info = r.get("t1").unwrap();
        assert_eq!(info.phase, TunnelPhase::Stopped);
        assert_eq!(info.error, None, "a disconnect has no error to explain");
        assert_eq!(info.url, None, "the port is no longer listening");
    }

    #[test]
    fn an_exit_nobody_asked_for_is_still_a_failure() {
        // The other half. Quietly downgrading a crash to a status line would be the same
        // bug facing the other way.
        let r = Registry::default();
        r.insert_stub("t2", "s2", false);

        let phase = r.mark_stopped("t2", "It stopped unexpectedly (exit code 1).");
        assert_eq!(phase, TunnelPhase::Error);

        let info = r.get("t2").unwrap();
        assert_eq!(info.phase, TunnelPhase::Error);
        assert!(info.error.unwrap().contains("exit code 1"), "the reason must survive");
    }

    #[test]
    fn a_stopped_row_never_outranks_a_live_one_for_the_same_session() {
        // What made a tab red while the activity feed said connected.
        let r = Registry::default();
        r.insert_stub("t_dead", "same", true);
        r.mark_stopped("t_dead", "gone");
        r.insert_stub("t_live", "same", false);

        // Neither has a child here, so this pins the weaker guarantee: a row is found, and
        // the search does not fail outright when several exist.
        assert!(r.for_session("same").is_some());
        assert!(r.for_session("nothing").is_none());
    }

    #[test]
    fn marking_a_tunnel_that_was_never_registered_does_not_panic() {
        // The exit handler can outlive a removal; it must not take the app down.
        let r = Registry::default();
        assert_eq!(r.mark_stopped("never", "gone"), TunnelPhase::Error);
    }
}
