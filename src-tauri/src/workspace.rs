//! Workspaces: a working copy on disk, plus the identity it acts as.
//!
//! The unit the user works in, and deliberately *not* a connection. Everything that
//! distinguishes one piece of work from another lives in the repository itself:
//!
//! - which host it talks to — `remote_url`, a loopback port
//! - who it acts as — `identity = "u-…"`, honoured by `lore` with no flag
//!
//! So a workspace stores almost nothing: a path, and a name to show. The host is **derived**
//! from the repository's port rather than stored, which is how reachability already works and
//! means there is no association to keep in step when either side changes.

use crate::lore::repo::{port_of, read_id_file, read_identity, read_remote_url};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Workspace {
    pub id: String,
    /// Absolute path to the working copy.
    pub path: String,
    /// What to call it. Defaults to the folder name; kept separately so two clones of one
    /// repository can be told apart.
    pub name: String,
}

/// What can be known about a working copy without opening it.
///
/// Cheap on purpose: three file reads, no `lore` process. The tab strip needs this for every
/// workspace on every render of the connection state, and spawning a process per tab to
/// colour it would be absurd.
#[derive(Serialize, Clone, Debug)]
pub struct WorkspaceSummary {
    pub id: String,
    pub path: String,
    pub name: String,
    /// False when the folder has gone — a moved or deleted clone must not look healthy.
    pub exists: bool,
    pub remote_url: Option<String>,
    /// The port that names its host.
    pub remote_port: Option<u16>,
    /// The identity it acts as, when pinned.
    pub identity: Option<String>,
    /// The repository this is a clone of. Two workspaces sharing it are two clones of one
    /// repository — the arrangement the whole identity design exists to support.
    pub repository_id: Option<String>,
    /// This working copy's own id. Stable across renaming or moving the folder, which a path
    /// is not.
    pub instance_id: Option<String>,
}

fn path_of(dir: &Path) -> PathBuf {
    dir.join("workspaces.json")
}

fn load_from(dir: &Path) -> Vec<Workspace> {
    std::fs::read_to_string(path_of(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_to(dir: &Path, list: &[Workspace]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(path_of(dir), json).map_err(|e| {
        format!("Could not save workspaces to {}: {e}", path_of(dir).display())
    })
}

/// Everything known about one working copy, without running anything.
pub fn summarise(w: &Workspace) -> WorkspaceSummary {
    let p = PathBuf::from(&w.path);
    // A repository is a folder with a `.lore` directory. Anything else — moved, deleted,
    // never a repository — is reported as gone rather than as an empty one.
    let exists = p.join(".lore").is_dir();
    let remote_url = if exists { read_remote_url(&p) } else { None };
    WorkspaceSummary {
        id: w.id.clone(),
        path: w.path.clone(),
        name: w.name.clone(),
        exists,
        remote_port: remote_url.as_deref().and_then(port_of),
        remote_url,
        identity: if exists { read_identity(&p) } else { None },
        repository_id: exists.then(|| read_id_file(&p, "id")).flatten(),
        instance_id: exists.then(|| read_id_file(&p, "instance")).flatten(),
    }
}

#[tauri::command]
pub fn load_workspaces() -> Result<Vec<WorkspaceSummary>, String> {
    let dir = crate::session::app_dir()?;
    Ok(load_from(&dir).iter().map(summarise).collect())
}

/// Add a working copy, or return the existing one for that path.
///
/// Idempotent by path: the same folder opened twice is one workspace. Two *clones* are two
/// folders and so two workspaces, which is the case that matters — that is how one person
/// works as two identities against one repository.
#[tauri::command]
pub fn add_workspace(path: String, name: Option<String>) -> Result<Vec<WorkspaceSummary>, String> {
    let dir = crate::session::app_dir()?;
    let mut list = load_from(&dir);

    if !PathBuf::from(&path).join(".lore").is_dir() {
        return Err(format!(
            "{path} is not a Lore repository — it has no .lore folder. Choose the folder you \
             cloned, not a folder inside it."
        ));
    }

    if !list.iter().any(|w| w.path == path) {
        let fallback = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        list.push(Workspace {
            // Path-derived ids would break when a folder is renamed; a counter would collide
            // across runs. The length is a cheap monotonic stand-in with no clock.
            id: format!("w{}-{}", list.len() + 1, fallback.chars().take(8).collect::<String>()),
            path,
            name: name.unwrap_or(fallback),
        });
        save_to(&dir, &list)?;
    }
    Ok(list.iter().map(summarise).collect())
}

/// Pin a workspace to an identity, or unpin it.
///
/// The one setting here that is not cosmetic: it decides *who this working copy acts as*, and
/// it is how two clones of one repository serve two different people. Written into the
/// repository's own config because that is where `lore` reads it — see `write_identity`.
#[tauri::command]
pub fn set_workspace_identity(id: String, identity: Option<String>) -> Result<Vec<WorkspaceSummary>, String> {
    let dir = crate::session::app_dir()?;
    let list = load_from(&dir);
    let w = list
        .iter()
        .find(|w| w.id == id)
        .ok_or_else(|| "That workspace is no longer in the list.".to_string())?;
    crate::lore::repo::write_identity(Path::new(&w.path), identity.as_deref())?;
    Ok(list.iter().map(summarise).collect())
}

#[tauri::command]
pub fn remove_workspace(id: String) -> Result<Vec<WorkspaceSummary>, String> {
    let dir = crate::session::app_dir()?;
    let mut list = load_from(&dir);
    list.retain(|w| w.id != id);
    save_to(&dir, &list)?;
    Ok(list.iter().map(summarise).collect())
}

#[tauri::command]
pub fn rename_workspace(id: String, name: String) -> Result<Vec<WorkspaceSummary>, String> {
    let dir = crate::session::app_dir()?;
    let mut list = load_from(&dir);
    if let Some(w) = list.iter_mut().find(|w| w.id == id) {
        w.name = name;
    }
    save_to(&dir, &list)?;
    Ok(list.iter().map(summarise).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(dir: &Path, config: &str) -> String {
        std::fs::create_dir_all(dir.join(".lore")).unwrap();
        std::fs::write(dir.join(".lore/config.toml"), config).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn a_summary_reads_the_host_and_the_identity_without_running_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let path = repo(
            tmp.path(),
            "remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-87c4\"\n\n[store]\n",
        );
        let s = summarise(&Workspace { id: "w1".into(), path, name: "demo".into() });

        assert!(s.exists);
        assert_eq!(s.remote_port, Some(41400), "the port is what names the host");
        assert_eq!(s.identity.as_deref(), Some("u-87c4"));
    }

    #[test]
    fn a_folder_that_has_gone_is_not_reported_as_healthy() {
        // A moved or deleted clone must show as missing, not as a repository with no remote:
        // the second reads as "local only" and invites a push that cannot work.
        let s = summarise(&Workspace {
            id: "w1".into(),
            path: "/nowhere/at/all".into(),
            name: "gone".into(),
        });
        assert!(!s.exists);
        assert_eq!(s.remote_port, None);
        assert_eq!(s.identity, None);
    }

    #[test]
    fn a_folder_without_dot_lore_is_missing_rather_than_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let s = summarise(&Workspace {
            id: "w1".into(),
            path: tmp.path().to_string_lossy().to_string(),
            name: "not-a-repo".into(),
        });
        assert!(!s.exists);
    }

    #[test]
    fn two_clones_of_one_repository_are_two_workspaces() {
        // The whole point of the model: same repository, different folders, different
        // identities. Deduplicating by remote or by repository id would collapse them.
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let pa = repo(a.path(), "remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-87c4\"\n");
        let pb = repo(b.path(), "remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-99f5\"\n");

        let sa = summarise(&Workspace { id: "w1".into(), path: pa, name: "as ale".into() });
        let sb = summarise(&Workspace { id: "w2".into(), path: pb, name: "as uitest".into() });

        assert_eq!(sa.remote_port, sb.remote_port, "same host");
        assert_ne!(sa.identity, sb.identity, "different identities");
    }

    #[test]
    fn adding_the_same_folder_twice_keeps_one_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let path = repo(repo_dir.path(), "remote_url = \"grpc://127.0.0.1:41400\"\n");

        let mut list = load_from(dir.path());
        assert!(list.is_empty());
        list.push(Workspace { id: "w1".into(), path: path.clone(), name: "demo".into() });
        save_to(dir.path(), &list).unwrap();

        let reloaded = load_from(dir.path());
        assert_eq!(reloaded.len(), 1);
        assert!(reloaded.iter().any(|w| w.path == path));
    }

    #[test]
    fn a_missing_or_corrupt_file_loads_as_empty_rather_than_failing() {
        // This runs at startup; it must never be why the app will not open.
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from(dir.path()).is_empty());
        std::fs::write(path_of(dir.path()), "not json").unwrap();
        assert!(load_from(dir.path()).is_empty());
    }
}

#[cfg(test)]
mod identity_file_tests {
    use super::*;
    use crate::lore::repo::read_id_file;

    fn repo_with_ids(id: &[u8], instance: &[u8]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".lore")).unwrap();
        std::fs::write(dir.path().join(".lore/config.toml"), "remote_url = \"grpc://127.0.0.1:41400\"\n").unwrap();
        std::fs::write(dir.path().join(".lore/id"), id).unwrap();
        std::fs::write(dir.path().join(".lore/instance"), instance).unwrap();
        dir
    }

    #[test]
    fn the_two_ids_lore_writes_are_read_as_hex() {
        // Captured from a real clone: 16 raw bytes each, and the repository id matches what
        // `lore status` prints.
        let dir = repo_with_ids(
            &hex(b"019f9e9f8f157e12a7ab77330299cfd4"),
            &hex(b"019fa925690c7a13a052d4bbe40a1812"),
        );
        let s = summarise(&Workspace { id: "w1".into(), path: dir.path().to_string_lossy().into(), name: "demo".into() });
        assert_eq!(s.repository_id.as_deref(), Some("019f9e9f8f157e12a7ab77330299cfd4"));
        assert_eq!(s.instance_id.as_deref(), Some("019fa925690c7a13a052d4bbe40a1812"));
    }

    #[test]
    fn two_clones_share_a_repository_id_and_differ_by_instance() {
        // The relationship the UI needs to state: same repository, different working copies.
        let a = repo_with_ids(&hex(b"019f9e9f8f157e12a7ab77330299cfd4"), &hex(b"11111111111111111111111111111111"));
        let b = repo_with_ids(&hex(b"019f9e9f8f157e12a7ab77330299cfd4"), &hex(b"22222222222222222222222222222222"));
        let sa = summarise(&Workspace { id: "w1".into(), path: a.path().to_string_lossy().into(), name: "a".into() });
        let sb = summarise(&Workspace { id: "w2".into(), path: b.path().to_string_lossy().into(), name: "b".into() });

        assert_eq!(sa.repository_id, sb.repository_id);
        assert_ne!(sa.instance_id, sb.instance_id);
    }

    #[test]
    fn a_file_of_the_wrong_length_is_not_an_id() {
        // Better to say nothing than to show a truncated hex string as an identifier.
        let dir = repo_with_ids(b"short", &hex(b"019fa925690c7a13a052d4bbe40a1812"));
        assert_eq!(read_id_file(dir.path(), "id"), None);
        assert!(read_id_file(dir.path(), "instance").is_some());
    }

    fn hex(s: &[u8]) -> Vec<u8> {
        let text = std::str::from_utf8(s).unwrap();
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }
}
