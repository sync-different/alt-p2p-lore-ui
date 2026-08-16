//! Tauri commands for working with a local Lore repository.
//!
//! Read-only for M2 — nothing here mutates a repository or touches the network. Every
//! command takes an explicit working-copy path rather than relying on a "current
//! repository" held in the backend, so several repositories can be open at once without
//! any of them being ambient state that a stale request could act on.

use super::cmd::{self, LoreError};
use super::parse::{self, Branches, FileDiff, RepoStatus};
use super::progress;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Turn a rich error into the single sentence the UI shows.
///
/// Tauri commands must return a `String` error, and this is the boundary where the detail
/// stops being structured. Keeping the conversion in one place stops the phrasing drifting
/// between commands.
fn to_message(e: LoreError) -> String {
    e.to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoInfo {
    pub path: String,
    pub status: RepoStatus,
    pub branches: Branches,
    /// Where this working copy dials, verbatim from `.lore/config.toml`.
    pub remote_url: Option<String>,
    /// The identity this working copy acts as, when it is pinned to one.
    ///
    /// `lore` supports `identity = "u-…"` at the root of `.lore/config.toml`, and honours it
    /// without any flag — which is how one machine can hold two clones of one repository
    /// acting as two different people. It is also a trap when the named identity is not
    /// signed in: every call fails with "No token stored", which reads as an expired session
    /// and is not one.
    pub identity: Option<String>,
    /// The loopback port in that URL, when it has one.
    ///
    /// Carried separately because it is the thing that goes wrong: the remote is pinned to a
    /// *port*, not to a session, so a working copy cloned through one tunnel is unreachable
    /// through another that forwards a different port. lore reports that as
    /// "Disconnected from server", which points at the network and not at the mismatch.
    pub remote_port: Option<u16>,
}

/// Read `remote_url` out of `.lore/config.toml`.
///
/// Read directly because no `lore` subcommand prints it, and a whole TOML parser would be a
/// dependency for one top-level string. Only lines *before* the first `[section]` count —
/// the key is at the document root, and a same-named key inside `[store]` would not be it.
pub fn read_remote_url(repo: &Path) -> Option<String> {
    let text = std::fs::read_to_string(repo.join(".lore/config.toml")).ok()?;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            break;
        }
        if let Some(v) = t.strip_prefix("remote_url") {
            let v = v.trim_start().strip_prefix('=')?.trim();
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

/// Read the pinned `identity` out of `.lore/config.toml`, if there is one.
///
/// Same root-only rule as `read_remote_url`: the key sits at the document root.
pub fn read_identity(repo: &Path) -> Option<String> {
    let text = std::fs::read_to_string(repo.join(".lore/config.toml")).ok()?;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            break;
        }
        if let Some(v) = t.strip_prefix("identity") {
            let v = v.trim_start().strip_prefix('=')?.trim();
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

/// A repository on a host, as `lore repository list` names it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RemoteRepo {
    /// What people call it — the only part a user should ever have to know.
    pub name: String,
    /// The id, which appears in grants and in the token store but never needs typing.
    pub id: String,
}

/// Parse `lore repository list`, whose output is one `name (id)` per line.
///
/// An empty list is a real answer, not a failure: it means this identity has been granted
/// nothing on that host — the same state the identity service logs as `EMPTY`.
pub fn parse_repository_list(text: &str) -> Vec<RemoteRepo> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // `name (id)`. A line without the bracketed id is not a repository row — lore prints
        // warnings on the same stream — so it is skipped rather than shown as a repository
        // called "Warning: …".
        let Some(open) = t.rfind(" (") else { continue };
        let Some(close) = t.rfind(')') else { continue };
        if close < open {
            continue;
        }
        let name = t[..open].trim();
        let id = t[open + 2..close].trim();
        if name.is_empty() || id.is_empty() {
            continue;
        }
        out.push(RemoteRepo { name: name.to_string(), id: id.to_string() });
    }
    out
}

/// Ask a host what this identity may clone.
#[tauri::command]
pub async fn list_repositories(
    app: AppHandle,
    url: String,
    identity: Option<String>,
) -> Result<Vec<RemoteRepo>, String> {
    let cwd = std::env::temp_dir();
    let mut args = vec!["repository".into(), "list".into(), url];
    if let Some(who) = identity {
        // Listing is per-identity: it returns what *this* user is granted, so asking as the
        // wrong one shows an empty host that is not empty.
        args.push("--identity".into());
        args.push(who);
    }
    let out = cmd::run(&app, &cwd, args, Some(std::time::Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_repository_list(&out.stdout))
}

/// A 16-byte id file under `.lore`, as hex.
///
/// Lore writes two of them and they answer different questions: `id` is the **repository**
/// (the same in every clone of it), `instance` is **this working copy** (a UUIDv7, unique per
/// clone — see the system-design docs, where multiple instances of one repository on one
/// machine are an explicitly supported arrangement).
///
/// Read directly because no command prints them, and because they are the only identifiers
/// here that survive renaming a folder.
pub fn read_id_file(repo: &Path, name: &str) -> Option<String> {
    let bytes = std::fs::read(repo.join(".lore").join(name)).ok()?;
    // Exactly 16 bytes or it is not one of these ids, and guessing would put nonsense in
    // front of the user.
    (bytes.len() == 16).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Pin a working copy to an identity, or unpin it.
///
/// Writes the `identity` key at the root of `.lore/config.toml` — the same key `lore` reads,
/// and the only way to make two clones of one repository act as two different people.
///
/// **This edits another program's configuration**, which is not something to do lightly. It
/// is justified here because `lore` exposes no command to set it (there is no `lore config`),
/// the key is a documented plain scalar, and the alternative is a feature that can only be
/// used by hand-editing a file most users will never find. The write is confined to one
/// root-level line: sections and everything in them are copied through untouched.
///
/// Written via a temporary file and renamed, so an interrupted write cannot leave a working
/// copy with a truncated config — which `lore` would refuse to open at all.
pub fn write_identity(repo: &Path, identity: Option<&str>) -> Result<(), String> {
    let path = repo.join(".lore/config.toml");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;

    let mut out: Vec<String> = Vec::with_capacity(text.lines().count() + 1);
    let mut in_root = true;
    let mut written = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            // Leaving the document root: this is the last chance to add the key, because
            // anything below belongs to a section and would be a different setting.
            if in_root && !written {
                if let Some(id) = identity {
                    out.push(format!("identity = \"{id}\""));
                }
                written = true;
            }
            in_root = false;
        }
        if in_root && t.starts_with("identity") && t.contains('=') {
            if let Some(id) = identity {
                out.push(format!("identity = \"{id}\""));
            }
            // Unpinning drops the line entirely rather than writing an empty value, which
            // `lore` would read as an identity named "".
            written = true;
            continue;
        }
        out.push(line.to_string());
    }
    if !written {
        if let Some(id) = identity {
            out.push(format!("identity = \"{id}\""));
        }
    }

    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, out.join("\n") + "\n")
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not update {}: {e}", path.display()))
}

/// The port a `grpc://host:port` URL dials.
pub fn port_of(url: &str) -> Option<u16> {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme.split(['/', '?']).next()?;
    // Rightmost colon, so an IPv6 literal in brackets does not confuse it.
    let port = authority.rsplit_once(':')?.1;
    port.chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// How status is always asked for.
///
/// **`--scan` is not optional.** Without it `lore status` does not see new files at all — a
/// file created on disk is simply absent, which is why one added to a working copy never
/// appeared in the tree. Scanning reconciles the working copy with what lore has recorded.
///
/// It is a local mutation (files get marked dirty), and it costs 225ms on a 2 GiB working copy
/// and 83ms warm, so there is no reason to defer it to a special "deep refresh" the user has
/// to know about.
///
/// **`--offline` is deliberately absent.** It suppresses the two lines that say where the
/// branch stands — "Remote revision …" and "Local branch is ahead of remote" — so with it the
/// app could never know a push was possible, and Push stayed disabled after a commit.
///
/// It was there to keep reading state independent of a host, and that fear turned out to be
/// unfounded: measured against a host that was down, the online form returns in 24ms with no
/// error and simply omits the remote lines. Unknown standing is then reported as unknown,
/// which is honest, rather than as "nothing to push", which is not.
fn status_args() -> Vec<String> {
    vec!["status".into(), "--scan".into()]
}

/// Stage paths for the next commit.
///
/// `--scan` is passed because `lore stage` **does not walk the filesystem**: without it, only
/// files already marked dirty are staged, so staging a file the user can plainly see would
/// silently do nothing. With it, discovery and staging happen in one pass.
///
/// Paths are passed explicitly rather than staging everything, because the user chose them —
/// and a commit that quietly includes more than was ticked is the worst kind of surprise in a
/// tool that moves other people's work.
#[tauri::command]
pub async fn stage_paths(app: AppHandle, path: String, paths: Vec<String>) -> Result<RepoStatus, String> {
    if paths.is_empty() {
        return Err("Nothing was selected to stage.".into());
    }
    let cwd = PathBuf::from(&path);
    let args = cmd::with_positional(vec!["stage".into(), "--scan".into()], paths);
    // Staging hashes the file content, so staging a multi-GB file scales with its size, not a
    // fixed cost — the same reason commit and reset get the long deadline rather than 120s.
    cmd::run(&app, &cwd, args, Some(cmd::DATA_TRANSFER_TIMEOUT))
        .await
        .map_err(to_message)?;
    read_status(&app, &cwd).await
}

/// Take paths back out of the next commit. The files on disk are untouched.
#[tauri::command]
pub async fn unstage_paths(app: AppHandle, path: String, paths: Vec<String>) -> Result<RepoStatus, String> {
    if paths.is_empty() {
        return Err("Nothing was selected to unstage.".into());
    }
    let cwd = PathBuf::from(&path);
    let args = cmd::with_positional(vec!["unstage".into()], paths);
    cmd::run(&app, &cwd, args, None).await.map_err(to_message)?;
    read_status(&app, &cwd).await
}

/// Read status the one way it is ever read.
async fn read_status(app: &AppHandle, cwd: &Path) -> Result<RepoStatus, String> {
    let out = cmd::run(app, cwd, status_args(), Some(cmd::SCAN_TIMEOUT)).await.map_err(to_message)?;
    Ok(parse::parse_status(&out.stdout))
}

/// Run a data-moving write under a progress monitor, then return the status it produced — with
/// the monitor kept alive across **both** the command and the status re-read.
///
/// The re-read is the subtle part: `status --scan` re-hashes changed files, so on a large
/// repository it is itself minutes of work. If the monitor stopped when the command returned,
/// the operation's UI would look finished and then sit frozen through that scan (observed: a
/// restore that completed, then a re-read that "did not finish within 120s"). Keeping the same
/// monitor running means its "still working — Ns" signal covers the scan too; bytes stay flat
/// there (a scan writes nothing) while the elapsed clock keeps the UI honest that it is alive.
async fn run_monitored(
    app: &AppHandle,
    cwd: &Path,
    path: &str,
    op: &str,
    args: Vec<String>,
) -> Result<RepoStatus, String> {
    let monitor = progress::Monitor::start(app.clone(), path.to_string(), op);
    let ran = cmd::run(app, cwd, args, Some(cmd::DATA_TRANSFER_TIMEOUT)).await;
    let result = match ran {
        Ok(_) => read_status(app, cwd).await,
        Err(e) => Err(to_message(e)),
    };
    monitor.finish().await;
    result
}

/// Commit what is staged.
///
/// The message is a positional argument, so an empty one would be a missing argument rather
/// than an empty message — refused here, where the reason can be said plainly.
///
/// Nothing is staged implicitly: `lore commit` writes what the previous `stage` calls put
/// there, which is what the user ticked. A commit that quietly includes more than was chosen
/// is the worst kind of surprise in a tool that moves other people's work.
#[tauri::command]
pub async fn commit(app: AppHandle, path: String, message: String) -> Result<RepoStatus, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("A commit needs a message.".into());
    }
    let cwd = PathBuf::from(&path);
    // Commit uploads every changed fragment to the host — the heavy network operation, not push
    // (which only moves the branch pointer). Its data goes *up*, so the working copy barely
    // changes on disk and the elapsed timer is what tells the UI it is alive; still worth the
    // monitor, since a multi-GB commit is otherwise a frozen button for minutes.
    run_monitored(
        &app,
        &cwd,
        &path,
        "commit",
        cmd::with_positional(vec!["commit".into()], [message]),
    )
    .await
}

/// Throw away changes.
///
/// Two very different operations behind one word, kept apart deliberately:
///
/// - **restore** (`lore reset <paths>`) puts tracked files back to the committed revision.
///   Run against a file lore does not track it reports "No files reset" and changes nothing.
/// - **purge** (`--purge`) *deletes untracked files from disk*. That is the only way to remove
///   a new file through lore, and it is unrecoverable — there is no earlier revision to go
///   back to, because the file was never committed.
///
/// `purge` is therefore never implied. The caller has to ask for it, and the UI has to have
/// said what it means.
#[tauri::command]
pub async fn reset_paths(
    app: AppHandle,
    path: String,
    paths: Vec<String>,
    purge: bool,
) -> Result<RepoStatus, String> {
    if paths.is_empty() {
        return Err("Nothing was selected to discard.".into());
    }
    let cwd = PathBuf::from(&path);
    let mut flags = vec!["reset".into()];
    if purge {
        flags.push("--purge".into());
    }
    let args = cmd::with_positional(flags, paths);
    // Restoring a deleted file re-materialises it from the store, and a purge can remove a lot of
    // data — both scale with the file. Observed: discarding a deleted 4 GB file ran `lore reset`
    // past the 120s default and the restore "failed" on a timeout while it was still working.
    // Runs under the monitor (bytes climb as the file is restored), which also covers the slow
    // post-restore status scan that used to freeze the dialog. See run_monitored.
    run_monitored(&app, &cwd, &path, "reset", args).await
}

/// Bring the remote's work down, merging if both sides have moved.
///
/// A sync that merges writes 3-way conflict markers into the files and leaves a **pending
/// merge** that must be resolved and committed before anything can be pushed. That is not a
/// failure — it is the normal outcome of two people editing one file — so it is reported
/// through the status this returns rather than as an error.
#[tauri::command]
pub async fn sync(app: AppHandle, path: String) -> Result<RepoStatus, String> {
    let cwd = PathBuf::from(&path);
    // A sync pulls the remote's changes, which scales with the data — minutes on a large delta
    // or a slow link. It runs under a monitor whose bytes-landing/temp-file progress the UI
    // shows (see progress.rs and run_monitored); without it a large sync is indistinguishable
    // from a hang, which was a real report.
    run_monitored(&app, &cwd, &path, "sync", vec!["sync".into()]).await
}

/// Send commits to the host.
///
/// `--fast-forward-merge` is needed after a merge and harmless otherwise. Established by
/// hand: having resolved a conflict and committed the merge, a plain `push` still reported
/// "Branch has diverged, sync to merge remote changes", and the flag is what completes it.
/// Passing it only "when merging" would mean guessing at a state the user cannot see.
#[tauri::command]
pub async fn push(app: AppHandle, path: String) -> Result<RepoStatus, String> {
    let cwd = PathBuf::from(&path);
    // Push is usually an instant pointer move, but if a commit's fragments never reached the host
    // (committed while it was unreachable), push is what uploads them — a full data transfer. The
    // long deadline never fires on the common instant case; it only saves the large-upload one.
    cmd::run(
        &app,
        &cwd,
        vec!["push".into(), "--fast-forward-merge".into()],
        Some(cmd::DATA_TRANSFER_TIMEOUT),
    )
    .await
    .map_err(to_message)?;
    read_status(&app, &cwd).await
}

/// Resolve conflicted files by taking one side wholesale.
///
/// **Editing the file is not enough.** With the markers removed by hand, `lore commit` still
/// refuses: "Unable to commit when <path> is still in conflict". Only this clears the flag,
/// which is why the app offers it rather than leaving someone to discover the command.
///
/// `take_mine` means **the user keeps their own local work** — see `resolve_side_arg` for the
/// word it maps to, which is not the obvious one. Both choices discard the other side for that
/// file, which is why the UI names the files and the choice.
/// Which side `lore branch merge resolve` must be given to honour the user's choice.
///
/// **lore's words are inverted from the user's point of view.** During the sync that created
/// the conflict, lore has already moved the working copy onto the *incoming* revision — so in
/// its merge, "mine" is the **host's** side and "theirs" is the **user's local** side. Proven
/// by a controlled two-clone experiment against a scratch loreserver (2026-08-16): with local
/// edit B and remote edit A in conflict, `resolve mine` left **A** (the host's line) and
/// `resolve theirs` left **B** (the user's). The first shipped version passed `mine` for
/// "keep my version", which silently **discarded the user's work while claiming to keep it** —
/// the exact inversion this function exists to pin.
fn resolve_side_arg(keep_user_version: bool) -> &'static str {
    if keep_user_version { "theirs" } else { "mine" }
}

#[tauri::command]
pub async fn resolve_conflicts(
    app: AppHandle,
    path: String,
    paths: Vec<String>,
    take_mine: bool,
) -> Result<RepoStatus, String> {
    if paths.is_empty() {
        return Err("No conflicted files were selected.".into());
    }
    let cwd = PathBuf::from(&path);
    let flags = vec![
        "branch".into(),
        "merge".into(),
        "resolve".into(),
        resolve_side_arg(take_mine).into(),
    ];
    let args = cmd::with_positional(flags, paths);
    // Taking one side of a conflict rewrites the file's content from the store, so a large
    // conflicted file scales with its size. Monitored like the rest, which also covers the
    // post-write scan.
    run_monitored(&app, &cwd, &path, "resolve", args).await
}

/// Abandon a merge and go back to where the working copy was before it started.
#[tauri::command]
pub async fn abort_merge(app: AppHandle, path: String) -> Result<RepoStatus, String> {
    let cwd = PathBuf::from(&path);
    // Abandoning a merge re-materialises the working tree back to its pre-merge state, rewriting
    // whatever the merge touched — monitored like the rest (bytes climb as files are rewritten).
    run_monitored(
        &app,
        &cwd,
        &path,
        "abort",
        vec!["branch".into(), "merge".into(), "abort".into()],
    )
    .await
}

/// Files whose local edits would be overwritten by a switch.
///
/// lore refuses rather than overwriting — "File has local changes: note.txt (incoming size 62
/// bytes, file system size 32 bytes)" — and it only objects to files that actually *differ
/// between the two branches*. Uncommitted work in files the branches agree on carries across
/// untouched, so warning about every local change would be warning about nothing most of the
/// time.
pub fn blocking_files(err: &str) -> Vec<String> {
    err.lines()
        .filter_map(|l| l.split("File has local changes:").nth(1))
        .map(|rest| rest.split(" (").next().unwrap_or(rest).trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// What a branch switch would do, without doing it.
///
/// `--dry-run` predicts the refusal exactly — verified against a working copy where a switch
/// was blocked — so the app can ask first instead of attempting and translating a failure.
#[tauri::command]
pub async fn check_switch_branch(
    app: AppHandle,
    path: String,
    branch: String,
) -> Result<Vec<String>, String> {
    let cwd = PathBuf::from(&path);
    match cmd::run(
        &app,
        &cwd,
        cmd::with_positional(
            vec!["branch".into(), "switch".into(), "--dry-run".into()],
            [branch],
        ),
        None,
    )
    .await
    {
        Ok(_) => Ok(Vec::new()),
        Err(e) => {
            let text = e.to_string();
            let blocked = blocking_files(&text);
            // Blocked by local edits is an answer, not a failure; anything else is a failure.
            if blocked.is_empty() {
                Err(to_message(e))
            } else {
                Ok(blocked)
            }
        }
    }
}

/// Switch branches. The working copy is rewritten to match.
#[tauri::command]
pub async fn switch_branch(app: AppHandle, path: String, branch: String) -> Result<RepoStatus, String> {
    let cwd = PathBuf::from(&path);
    // "The working copy is rewritten to match" — switching a branch re-materialises every file
    // that differs between the two branches. On a large repository that is gigabytes of writes,
    // monitored like the rest: bytes climb on disk as the files are written.
    run_monitored(
        &app,
        &cwd,
        &path,
        "switch",
        cmd::with_positional(vec!["branch".into(), "switch".into()], [branch]),
    )
    .await
}

/// Start a new branch here, at the current revision.
#[tauri::command]
pub async fn create_branch(app: AppHandle, path: String, branch: String) -> Result<RepoStatus, String> {
    let name = branch.trim().to_string();
    if name.is_empty() {
        return Err("A branch needs a name.".into());
    }
    let cwd = PathBuf::from(&path);
    cmd::run(
        &app,
        &cwd,
        cmd::with_positional(vec!["branch".into(), "create".into()], [name.clone()]),
        None,
    )
    .await
    .map_err(to_message)?;
    // Creating does not switch: lore leaves you where you were, and pretending otherwise
    // would put someone on a branch they did not ask to be on.
    read_status(&app, &cwd).await
}

/// Cheap structural check before spending a process on it.
///
/// A `.lore` directory is what makes a folder a repository; testing for it lets the picker
/// reject a wrong choice instantly and say so in the user's terms, rather than surfacing
/// whatever `lore` prints when run somewhere it does not belong.
#[tauri::command]
pub fn is_lore_repo(path: String) -> bool {
    Path::new(&path).join(".lore").is_dir()
}

/// Open a repository: validate, then read status and branches.
#[tauri::command]
pub async fn open_repo(app: AppHandle, path: String) -> Result<RepoInfo, String> {
    let cwd = PathBuf::from(&path);

    if !cwd.is_dir() {
        return Err(format!("There is no folder at {path}."));
    }
    if !cwd.join(".lore").is_dir() {
        return Err(format!(
            "{path} is not a Lore repository — it has no .lore folder. Choose the folder \
             you cloned, not a folder inside it."
        ));
    }

    let remote = read_remote_url(&cwd);
    let identity = read_identity(&cwd);

    let status_out = cmd::run(&app, &cwd, status_args(), Some(cmd::SCAN_TIMEOUT))
        .await
        .map_err(to_message)?;
    let branch_out = cmd::run(
        &app,
        &cwd,
        // Online for the same reason as status: `--offline` omits the "Remote branches"
        // section entirely, so a branch that exists only on the host becomes invisible. With
        // the host down this degrades to a warning line and the local branches still list.
        vec!["branch".into(), "list".into()],
        None,
    )
    .await
    .map_err(to_message)?;

    Ok(RepoInfo {
        path,
        status: parse::parse_status(&status_out.stdout),
        branches: parse::parse_branches(&branch_out.stdout),
        identity,
        remote_url: remote.clone(),
        remote_port: remote.as_deref().and_then(port_of),
    })
}

/// Re-read status. Separate from `open_repo` because it is called often — 0.06s on a 2 GB
/// repository means this can run on demand and on window focus without a cache.
#[tauri::command]
pub async fn repo_status(app: AppHandle, path: String) -> Result<RepoStatus, String> {
    let cwd = PathBuf::from(path);
    let out = cmd::run(&app, &cwd, status_args(), Some(cmd::SCAN_TIMEOUT))
        .await
        .map_err(to_message)?;
    Ok(parse::parse_status(&out.stdout))
}

/// Diff one file against the current revision.
///
/// An empty result is a success, not a failure: files marked dirty without being edited
/// produce no diff, and in the reference repository that is true of all 2163 of them.
#[tauri::command]
pub async fn file_diff(app: AppHandle, path: String, file: String) -> Result<FileDiff, String> {
    let cwd = PathBuf::from(path);
    let out = cmd::run(&app, &cwd, cmd::with_positional(vec!["diff".into()], [file]), None)
        .await
        .map_err(to_message)?;
    Ok(parse::parse_diff(&out.stdout))
}

#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    /// Path relative to the repository root, using `/` on every platform so it can be
    /// matched against `lore status` output directly.
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the epoch, or 0 when unavailable.
    pub modified_ms: u64,
    pub is_binary: bool,
}

/// List one directory of the working copy.
///
/// Deliberately not recursive. The reference repository has 1988 directories, and walking
/// them eagerly would delay the first paint for a tree the user has not asked to see —
/// lazy expansion is both faster and what a tree control implies.
#[tauri::command]
pub fn list_dir(root: String, rel: String) -> Result<Vec<DirEntry>, String> {
    let root_path = PathBuf::from(&root);
    let dir = if rel.is_empty() { root_path.clone() } else { root_path.join(&rel) };

    // Refuse anything that escapes the repository. `rel` originates in the UI, and a
    // traversal here would let a crafted value read outside the folder the user chose.
    let canonical_root = root_path.canonicalize().map_err(|e| format!("{root}: {e}"))?;
    let canonical_dir = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("That path is outside the repository.".into());
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&canonical_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        // The store is Lore's business, not the user's.
        if name == ".lore" {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            // A file that vanished between listing and stat is not an error worth failing
            // the whole directory for.
            Err(_) => continue,
        };

        let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(DirEntry {
            is_binary: !meta.is_dir() && parse::is_binary_extension(&rel_path),
            name,
            rel_path,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified_ms,
        });
    }

    // Directories first, then case-insensitive by name — the ordering a file browser
    // implies, and stable so the tree does not reshuffle between refreshes.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(out)
}

// Locks live in `super::locks`: reading them is only half the story once they can also be
// taken and broken, and the rules about ownership are worth keeping in one place.

#[cfg(test)]
mod remote_tests {
    use super::{port_of, read_remote_url};

    /// A working copy's config, in the layout `lore` actually writes: the remote at the
    /// document root, sections after it.
    fn repo_with(config: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".lore")).unwrap();
        std::fs::write(dir.path().join(".lore/config.toml"), config).unwrap();
        dir
    }

    #[test]
    fn the_remote_is_read_from_the_document_root() {
        let dir = repo_with(
            "remote_url = \"grpc://127.0.0.1:41400\"\n\n[store]\nmax_capacity = 2000000\n",
        );
        assert_eq!(
            read_remote_url(dir.path()).as_deref(),
            Some("grpc://127.0.0.1:41400")
        );
    }

    #[test]
    fn a_key_inside_a_section_is_not_the_remote() {
        // The stop-at-first-section rule. A same-named key under [store] is a different key,
        // and treating it as the remote would silently point the check at the wrong port.
        let dir = repo_with("[store]\nremote_url = \"grpc://127.0.0.1:9999\"\n");
        assert_eq!(read_remote_url(dir.path()), None);
    }

    #[test]
    fn a_repository_without_a_remote_reads_as_none_rather_than_failing() {
        // A repository created locally has never been given one.
        let dir = repo_with("[store]\nmax_capacity = 1\n");
        assert_eq!(read_remote_url(dir.path()), None);
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read_remote_url(empty.path()), None);
    }

    #[test]
    fn a_pinned_identity_is_read_when_present() {
        // Found live: two clones of one repository, one of them pinned to a different user.
        // With that user signed out every call fails with "No token stored" — true, and
        // nothing about it suggests the repository is the reason.
        use super::read_identity;
        let dir = repo_with(
            "remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-87c4b8c8b7f44fc1\"\n\n[store]\n",
        );
        assert_eq!(read_identity(dir.path()).as_deref(), Some("u-87c4b8c8b7f44fc1"));
    }

    #[test]
    fn an_unpinned_repository_has_no_identity() {
        use super::read_identity;
        let dir = repo_with("remote_url = \"grpc://127.0.0.1:41400\"\n[store]\nidentity = \"u-nope\"\n");
        assert_eq!(read_identity(dir.path()), None, "a key inside a section is not it");
    }

    #[test]
    fn the_port_is_what_gets_compared() {
        assert_eq!(port_of("grpc://127.0.0.1:41400"), Some(41400));
        assert_eq!(port_of("grpc://127.0.0.1:41501/repo"), Some(41501));
        assert_eq!(port_of("https://example.com:8443"), Some(8443));
    }

    #[test]
    fn a_url_with_no_port_yields_none_rather_than_a_wrong_guess() {
        // No port means nothing to compare, and inventing 443 would produce a mismatch
        // warning about a port the user never chose.
        assert_eq!(port_of("grpc://example.com"), None);
        assert_eq!(port_of(""), None);
    }

    #[test]
    fn an_ipv6_literal_does_not_confuse_the_port() {
        assert_eq!(port_of("grpc://[::1]:41400"), Some(41400));
    }
}

#[cfg(test)]
mod identity_write_tests {
    use super::{read_identity, read_remote_url, write_identity};

    fn repo(config: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".lore")).unwrap();
        std::fs::write(dir.path().join(".lore/config.toml"), config).unwrap();
        dir
    }

    fn text(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(dir.path().join(".lore/config.toml")).unwrap()
    }

    #[test]
    fn pinning_an_unpinned_repository_adds_the_key_at_the_root() {
        let dir = repo("remote_url = \"grpc://127.0.0.1:41400\"\n\n[store]\nmax_capacity = 2000000\n");
        write_identity(dir.path(), Some("u-99f5")).unwrap();

        assert_eq!(read_identity(dir.path()).as_deref(), Some("u-99f5"));
        // The key must land above the first section, or it belongs to that section instead.
        let t = text(&dir);
        assert!(t.find("identity").unwrap() < t.find("[store]").unwrap());
    }

    #[test]
    fn everything_else_in_the_file_survives() {
        // This is another program's configuration. Losing a store setting to a rename would
        // be a far worse bug than the one this feature solves.
        let dir = repo(
            "remote_url = \"grpc://127.0.0.1:41400\"\n\n[store]\nmax_capacity = 2000000\nmax_size = 10737418240\n\n[file]\ndirect_io = false\n",
        );
        write_identity(dir.path(), Some("u-99f5")).unwrap();

        let t = text(&dir);
        assert_eq!(read_remote_url(dir.path()).as_deref(), Some("grpc://127.0.0.1:41400"));
        for kept in ["[store]", "max_capacity = 2000000", "max_size = 10737418240", "[file]", "direct_io = false"] {
            assert!(t.contains(kept), "lost {kept}:\n{t}");
        }
    }

    #[test]
    fn repinning_replaces_rather_than_duplicates() {
        let dir = repo("remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-87c4\"\n\n[store]\n");
        write_identity(dir.path(), Some("u-99f5")).unwrap();

        assert_eq!(read_identity(dir.path()).as_deref(), Some("u-99f5"));
        assert_eq!(text(&dir).matches("identity").count(), 1, "two keys, and lore reads the first");
    }

    #[test]
    fn unpinning_removes_the_key_rather_than_emptying_it() {
        // `identity = ""` would be read as an identity named "" — a token that can never be
        // found, which is worse than no pin at all.
        let dir = repo("remote_url = \"grpc://127.0.0.1:41400\"\nidentity = \"u-87c4\"\n[store]\n");
        write_identity(dir.path(), None).unwrap();

        assert_eq!(read_identity(dir.path()), None);
        assert!(!text(&dir).contains("identity"));
    }

    #[test]
    fn a_key_inside_a_section_is_left_alone() {
        // Only the root-level key is ours. A same-named key under [store] means something
        // else, and rewriting it would corrupt a setting we do not understand.
        let dir = repo("remote_url = \"grpc://127.0.0.1:41400\"\n\n[store]\nidentity = \"do-not-touch\"\n");
        write_identity(dir.path(), Some("u-99f5")).unwrap();

        let t = text(&dir);
        assert!(t.contains("identity = \"do-not-touch\""), "section key was altered:\n{t}");
        assert_eq!(read_identity(dir.path()).as_deref(), Some("u-99f5"));
    }

    #[test]
    fn a_config_with_no_sections_still_gets_the_key() {
        let dir = repo("remote_url = \"grpc://127.0.0.1:41400\"\n");
        write_identity(dir.path(), Some("u-99f5")).unwrap();
        assert_eq!(read_identity(dir.path()).as_deref(), Some("u-99f5"));
    }
}

#[cfg(test)]
mod repository_list_tests {
    use super::parse_repository_list;

    fn fixture(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn a_real_listing_yields_names_and_ids() {
        // Captured from ctone after implementing LookupUserPermissions: `name (id)` per line.
        let repos = parse_repository_list(&fixture("repository_list.txt"));
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name, "demo");
        assert_eq!(repos[0].id, "019f9e9f8f157e12a7ab77330299cfd4");
        assert_eq!(repos[1].name, "concept-art");
    }

    #[test]
    fn an_empty_listing_is_an_answer_rather_than_a_failure() {
        // What an identity with no grants gets. It means "nothing here for you", not "broken".
        assert!(parse_repository_list(&fixture("repository_list_empty.txt")).is_empty());
    }

    #[test]
    fn warnings_on_the_same_stream_are_not_mistaken_for_repositories() {
        // lore prints these inline; a repository called "Warning: could not query remote" would
        // be offered for cloning and fail in a way nobody could explain.
        let repos = parse_repository_list("Warning: something happened\ndemo (019f9e)\n");
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].name, "demo");
    }

    #[test]
    fn a_name_containing_brackets_keeps_the_last_pair_as_the_id() {
        let repos = parse_repository_list("demo (old) (019f9e)\n");
        assert_eq!(repos[0].name, "demo (old)");
        assert_eq!(repos[0].id, "019f9e");
    }
}

#[cfg(test)]
mod resolve_side_tests {
    use super::resolve_side_arg;

    #[test]
    fn keeping_the_users_version_sends_theirs_because_lores_words_are_inverted() {
        // Pinned by a live two-clone experiment (2026-08-16): after a sync-merge, lore's
        // "mine" is the HOST's side, not the user's. The first shipped mapping sent "mine"
        // for "Keep my version" and silently discarded the user's work — this test fails
        // against that code, which is the point of its existence.
        assert_eq!(resolve_side_arg(true), "theirs", "keep the user's local work");
        assert_eq!(resolve_side_arg(false), "mine", "take the host's incoming side");
    }
}
