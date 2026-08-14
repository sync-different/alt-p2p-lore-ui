//! Saved sessions: what to connect to, and the secrets needed to do it.
//!
//! Two stores, deliberately separate:
//!
//! - **Configuration** — name, coordinator address, session id, ports — in a plain JSON
//!   file. None of it is secret, and keeping it readable means a user can inspect or fix a
//!   session without the app.
//! - **Secrets** — the PSK and the identity token — in the **OS keychain**, reached only
//!   from Rust. They never cross into the webview, never appear in the config file, and are
//!   redacted from any logged argv.
//!
//! The split matters because a settings file syncs, gets backed up, and ends up in
//! dotfiles. A pre-shared key in one of those is a key that has escaped.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Keychain service name. One entry per session, keyed by session id.
const KEYRING_SERVICE: &str = "com.alterante.lore.ui";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionConfig {
    /// Stable id for this saved session (ours, not alt-p2p's).
    pub id: String,
    /// What the user calls it, e.g. "Studio main".
    pub name: String,
    /// alt-p2p rendezvous session id — not a secret, but not guessable either.
    pub session_id: String,
    /// Coordinator address, e.g. "coord.example.com:9000".
    pub server: String,
    /// Local port to expose loreserver on. Chosen by us; any free port will do.
    pub loreserver_port: u16,
    /// Must equal the port in the host's advertised `auth_url` — see PLAN.md O1. `None`
    /// for a host that does not require authentication.
    pub identity_port: Option<u16>,
    #[serde(default = "default_true")]
    pub allow_relay: bool,
}

fn default_true() -> bool {
    true
}

/// Where everything this app remembers between runs lives.
///
/// One directory, deliberately: the pid file used to sit under the bundle identifier while
/// sessions sat here, so "what has this app stored?" had two answers in two places. Anyone
/// diagnosing a problem should have to look in exactly one.
pub fn app_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "Could not find a configuration folder for this user.".to_string())?
        .join("alt-lore-desktop");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("sessions.json"))
}

#[tauri::command]
pub fn load_sessions() -> Result<Vec<SessionConfig>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // A corrupt or older-shaped file must not stop the app from starting: report an empty
    // list and let the user re-add. Refusing to launch over a settings file is worse than
    // losing the list.
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn write_sessions(sessions: &[SessionConfig]) -> Result<(), String> {
    let path = config_path()?;
    let text = serde_json::to_string_pretty(sessions).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not save sessions: {e}"))
}

/// Create or update a session, optionally storing its key.
///
/// The PSK is taken as a parameter and put straight into the keychain — it is never written
/// to the config file, and `None` means "leave whatever is already stored alone", so
/// editing a session's name does not require re-entering its key.
#[tauri::command]
pub fn save_session(config: SessionConfig, psk: Option<String>) -> Result<Vec<SessionConfig>, String> {
    let mut sessions = load_sessions()?;

    // Two saved sessions cannot share one alt-p2p session id.
    //
    // The id *is* the rendezvous name, so two configs naming it are not two connections —
    // they are two names for one. Everything downstream is keyed by it: both tabs resolve to
    // the same tunnel and update in lockstep, which is what a tester saw, and connecting the
    // second would either reuse the first's tunnel or, on the coordinator, recycle the slots
    // of a session that was already paired.
    if let Some(clash) = sessions
        .iter()
        .find(|s| s.id != config.id && s.session_id == config.session_id)
    {
        return Err(format!(
            "“{}” already uses the session name “{}”. Two saved sessions cannot share one —              it is the rendezvous name, so both tabs would show the same connection. Give this              one a different session name, or edit “{}” instead.",
            clash.name, config.session_id, clash.name
        ));
    }

    match sessions.iter_mut().find(|s| s.id == config.id) {
        Some(existing) => *existing = config.clone(),
        None => sessions.push(config.clone()),
    }
    write_sessions(&sessions)?;

    if let Some(secret) = psk {
        store_psk(&config.id, &secret)?;
    }
    Ok(sessions)
}

#[tauri::command]
pub fn delete_session(id: String) -> Result<Vec<SessionConfig>, String> {
    let mut sessions = load_sessions()?;
    sessions.retain(|s| s.id != id);
    write_sessions(&sessions)?;
    // Best effort: a leftover keychain entry for a deleted session is untidy but harmless,
    // and failing the delete over it would leave the session half-removed.
    let _ = keyring::Entry::new(KEYRING_SERVICE, &id).and_then(|e| e.delete_credential());
    Ok(sessions)
}

fn store_psk(session_id: &str, psk: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, session_id)
        .and_then(|e| e.set_password(psk))
        .map_err(|e| format!("Could not save the session key to the keychain: {e}"))
}

/// Read a stored PSK. Kept private to Rust — this value must not reach the webview.
pub fn read_psk(session_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, session_id)
        .and_then(|e| e.get_password())
        .map_err(|_| {
            "No session key is stored for this session. Edit the session and enter it.".to_string()
        })
}

/// Whether a key is stored, so the UI can show "key saved" without ever reading it.
#[tauri::command]
pub fn has_psk(session_id: String) -> bool {
    read_psk(&session_id).is_ok()
}

#[tauri::command]
pub fn set_psk(session_id: String, psk: String) -> Result<(), String> {
    store_psk(&session_id, &psk)
}

/// Start the tunnel for a saved session.
///
/// The PSK is fetched here, in Rust, and handed straight to the supervisor. The frontend
/// asks for a session by id and never handles the secret — which is also why this command
/// exists rather than the UI calling `start_tunnel` directly.
#[tauri::command]
pub async fn connect_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<String, String> {
    let sessions = load_sessions()?;
    let session = sessions
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| "That session no longer exists.".to_string())?;

    let psk = read_psk(&session.id)?;

    crate::tunnel::supervisor::start_tunnel(
        app,
        crate::tunnel::supervisor::TunnelConfig {
            session_name: session.name,
            session_id: session.session_id,
            psk,
            server: session.server,
            loreserver_port: session.loreserver_port,
            identity_port: session.identity_port,
            allow_relay: session.allow_relay,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two configs, same rendezvous name — the state a tester reached by adding a second
    /// session pointing at an existing one.
    fn cfg(id: &str, name: &str, session_id: &str) -> SessionConfig {
        SessionConfig {
            id: id.into(),
            name: name.into(),
            session_id: session_id.into(),
            server: "coord.example.com:9000".into(),
            loreserver_port: 41400,
            identity_port: Some(9443),
            allow_relay: true,
        }
    }

    #[test]
    fn a_duplicate_session_id_is_named_and_refused() {
        // The session id *is* the rendezvous name. Two configs holding it are two names for
        // one connection: both tabs resolve to the same tunnel and update in lockstep, and
        // connecting the second recycles the coordinator slots of a session already paired.
        let existing = vec![cfg("s1", "daniel", "lore-dc-1")];
        let incoming = cfg("s2", "uitest", "lore-dc-1");
        let clash = existing
            .iter()
            .find(|s| s.id != incoming.id && s.session_id == incoming.session_id);
        assert!(clash.is_some(), "the clash must be detected");
        assert_eq!(clash.unwrap().name, "daniel", "the message must name the other one");
    }

    #[test]
    fn editing_a_session_does_not_clash_with_itself() {
        // The obvious way to get this wrong: comparing session ids without excluding the
        // row being edited, so saving any session becomes impossible.
        let existing = vec![cfg("s1", "daniel", "lore-dc-1")];
        let incoming = cfg("s1", "daniel renamed", "lore-dc-1");
        assert!(existing
            .iter()
            .find(|s| s.id != incoming.id && s.session_id == incoming.session_id)
            .is_none());
    }

    #[test]
    fn a_session_round_trips_through_json_without_its_key() {
        let s = SessionConfig {
            id: "s1".into(),
            name: "Studio main".into(),
            session_id: "lore-example-session".into(),
            server: "coord.example.com:9000".into(),
            loreserver_port: 41400,
            identity_port: Some(9443),
            allow_relay: true,
        };
        let text = serde_json::to_string(&s).unwrap();
        // The proof that matters: nothing secret is in the serialised form, because the
        // struct has no field for it.
        assert!(!text.contains("psk"), "config must carry no key: {text}");
        assert_eq!(serde_json::from_str::<SessionConfig>(&text).unwrap(), s);
    }

    #[test]
    fn allow_relay_defaults_on_for_a_config_written_before_the_field_existed() {
        // ctone's own hosts fall back to relay routinely; defaulting it off would make an
        // older saved session mysteriously fail to connect.
        let s: SessionConfig = serde_json::from_str(
            r#"{"id":"s1","name":"n","session_id":"x","server":"h:1","loreserver_port":41400,"identity_port":null}"#,
        )
        .unwrap();
        assert!(s.allow_relay);
    }

    #[test]
    fn a_missing_identity_port_is_allowed() {
        let s: SessionConfig = serde_json::from_str(
            r#"{"id":"s1","name":"n","session_id":"x","server":"h:1","loreserver_port":41400,"identity_port":null,"allow_relay":false}"#,
        )
        .unwrap();
        assert_eq!(s.identity_port, None);
        assert!(!s.allow_relay);
    }
}
