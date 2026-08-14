//! Taking and releasing locks — the one place this app acts on **other people's** work.
//!
//! Everything else here affects a working copy that belongs to whoever is sitting in front of
//! it. A lock is shared state on the host: taking one stops a colleague editing, and releasing
//! one hands a file back whether or not they were finished. Three properties of the CLI, each
//! established against a live host, decide the whole design:
//!
//! 1. **A refused acquire never says who holds it.** The entire output is
//!    `Failed to lock-acquire 1 batch(es) out of 1` and a source location. Useless on its own —
//!    the answer to "why can't I edit this?" is a person's name, so this module fetches it.
//! 2. **Anyone can release anyone's lock, and `--force` is not required.** There is no
//!    ownership check to lean on. Whatever guard rail exists has to be built here.
//! 3. **The owner string is a display name, not an identifier.** The same lock reads
//!    `by Alejandro` in the workspace that holds it and `by ale` in another workspace on the
//!    same machine. Comparing it to a username to decide "is this mine?" would be wrong in
//!    whichever direction the day's rendering happened to fall.
//!
//! (3) is why ownership is asked of the server rather than inferred: `lock query --owner`
//! resolves an id, a username or a display name to the same account, so a second query names
//! *my* locks authoritatively. Unknown ownership is represented as unknown, never as "not
//! mine" — offering to break a lock that is actually your own is merely confusing, but the
//! reverse, quietly presenting someone else's lock as yours to release, is how work is lost.

use super::cmd;
use super::parse::{parse_locks, FileLock};
use serde::Serialize;
use std::path::PathBuf;
use tauri::AppHandle;

/// What actually happened, which is rarely just "yes".
///
/// A batch can be partly refused, and re-taking a lock you already hold is a success that
/// changed nothing. Collapsing those into a boolean would leave the UI unable to say which
/// files it may now edit.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct LockOutcome {
    /// Newly taken by this call.
    pub acquired: Vec<String>,
    /// Already held by this identity — a no-op the CLI reports separately, and not a failure.
    pub already_owned: Vec<String>,
    /// Released by this call.
    pub released: Vec<String>,
    /// Refused because someone else holds them, named. Empty on success.
    pub blocked: Vec<FileLock>,
}

/// Read the path lists out of a `lock acquire` / `lock release` report.
///
/// The output is a set of headed sections:
///
/// ```text
/// Lock acquired on files:
/// test2.txt
/// test3.txt
/// Lock already owned on files:
/// Daniel/Test.txt
/// ```
///
/// Sections are recognised by keyword rather than by exact header, because the header carries
/// a count in some builds and none in others, and a path is simply any line under one. Lines
/// before any header are ignored: a path with no section is a path with no meaning.
pub fn parse_lock_report(out: &str) -> LockOutcome {
    let mut outcome = LockOutcome::default();
    let mut section: Option<&str> = None;

    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }

        if t.ends_with(':') {
            let l = t.to_lowercase();
            // "already owned" is tested first: it also contains "acquire" in some phrasings,
            // and the difference between them is the whole point of reporting it.
            section = if l.contains("already") {
                Some("already")
            } else if l.contains("acquir") {
                Some("acquired")
            } else if l.contains("release") {
                Some("released")
            } else {
                None
            };
            continue;
        }

        // Diagnostics ride in the same stream; they are never paths.
        if t.starts_with("[Error]") || t.starts_with("at ") {
            continue;
        }

        match section {
            Some("acquired") => outcome.acquired.push(t.to_string()),
            Some("already") => outcome.already_owned.push(t.to_string()),
            Some("released") => outcome.released.push(t.to_string()),
            _ => {}
        }
    }

    outcome
}

/// An account this machine has signed in as, and what the user calls it.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct KnownIdentity {
    /// `u-…`, as `--owner` resolves it.
    pub id: String,
    /// The username shown everywhere else in the app — `ale`, not `Alejandro`.
    pub name: String,
}

/// Every lock on the branch, attributed to the accounts this machine knows.
///
/// Attribution is a query per known identity rather than a comparison, for the reason in the
/// module note: the printed owner is a display string that varies by viewer, while `--owner`
/// is resolved by the server. That is one extra process per account signed in on this machine
/// — one or two in practice — and it buys two things a comparison cannot:
///
/// - `mine`, which decides whether the UI offers *Unlock* or *Break lock*;
/// - `known_as`, so a lock held by `ale` says `ale` rather than `Alejandro`, which is the same
///   person under the name the host felt like using that minute.
///
/// A colleague nobody here has signed in as stays unattributed, keeping the host's own string.
/// That is honest: we genuinely do not know that account, and inventing a name for it would be
/// worse than showing the one the host gave.
#[tauri::command]
pub async fn list_locks(
    app: AppHandle,
    path: String,
    branch: String,
    identity: Option<String>,
    known: Option<Vec<KnownIdentity>>,
) -> Result<Vec<FileLock>, String> {
    let cwd = PathBuf::from(path);

    let out = cmd::run(
        &app,
        &cwd,
        vec!["lock".into(), "query".into(), "--branch".into(), branch.clone()],
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut locks = parse_locks(&out.stdout);

    let me = identity.filter(|s| !s.trim().is_empty());
    let mut accounts = known.unwrap_or_default();
    // The identity we act as must be asked about even when it is not in the known list — it is
    // the one answer the UI cannot do without.
    if let Some(me) = &me {
        if !accounts.iter().any(|a| &a.id == me) {
            accounts.push(KnownIdentity { id: me.clone(), name: me.clone() });
        }
    }
    if accounts.is_empty() {
        return Ok(locks);
    }

    attribute(&app, &cwd, &mut locks, Some(&branch), me.as_deref(), &accounts).await;
    Ok(locks)
}

/// Fill in `mine` and `known_as` by asking the server who holds what.
///
/// One `--owner` query per account. A failure is skipped rather than propagated: the locks are
/// real and worth showing even unattributed, and losing the whole list because one lookup
/// failed would trade a small loss of detail for a total one.
async fn attribute(
    app: &AppHandle,
    cwd: &std::path::Path,
    locks: &mut [FileLock],
    branch: Option<&str>,
    me: Option<&str>,
    accounts: &[KnownIdentity],
) {
    for account in accounts {
        let mut args: Vec<String> = vec!["lock".into(), "query".into()];
        if let Some(b) = branch {
            args.push("--branch".into());
            args.push(b.to_string());
        }
        args.push("--owner".into());
        args.push(account.id.clone());

        // A failure here ends attribution rather than skipping one account. The reason it
        // fails is a property of the *host*, not of the account: a server with no identity
        // provider answers every `--owner` with
        //   Failed to resolve user id from user name: No authentication configured on server
        // so trying the rest produces one identical error per account, per refresh, in the
        // user's console. The locks themselves are unaffected — they are simply unattributed,
        // which `mine: None` already means.
        let Ok(o) = cmd::run(app, cwd, args, None).await else { break };

        let held: std::collections::HashSet<String> =
            parse_locks(&o.stdout).into_iter().map(|l| l.path).collect();
        let is_me = me == Some(account.id.as_str());
        for l in locks.iter_mut() {
            if held.contains(&l.path) {
                l.known_as = Some(account.name.clone());
                l.mine = Some(is_me);
            } else if is_me {
                // Only the acting identity can settle *not* mine. Another account's query says
                // nothing about whether a lock is ours, so it must not write `false` here.
                l.mine = Some(l.mine.unwrap_or(false));
            }
        }
    }
}

/// Take locks on files.
///
/// **Contention is an answer, not an error.** `lore` fails the whole call and says only that a
/// batch failed, so on failure this asks who holds the requested paths and returns them as
/// `blocked`. The translation is conditional, in the way the rest of this app translates
/// errors: unless a requested path is independently found to be held by someone else, the
/// original failure is returned untouched. Otherwise an offline host would be reported as a
/// colleague's lock, sending someone to ask a person who did nothing.
#[tauri::command]
pub async fn acquire_locks(
    app: AppHandle,
    path: String,
    paths: Vec<String>,
    identity: Option<String>,
    known: Option<Vec<KnownIdentity>>,
) -> Result<LockOutcome, String> {
    if paths.is_empty() {
        return Ok(LockOutcome::default());
    }
    let cwd = PathBuf::from(path);

    let mut args: Vec<String> = vec!["lock".into(), "acquire".into()];
    args.extend(paths.iter().cloned());

    match cmd::run(&app, &cwd, args, None).await {
        Ok(out) => Ok(parse_lock_report(&out.stdout)),
        Err(e) => {
            let original = e.to_string();
            let blocked =
                held_by_others(&app, &cwd, &paths, identity.as_deref(), known.unwrap_or_default())
                    .await;
            if blocked.is_empty() {
                Err(original)
            } else {
                Ok(LockOutcome { blocked, ..Default::default() })
            }
        }
    }
}

/// Release locks.
///
/// `force` exists for breaking someone else's, though the CLI does not currently require it —
/// which is precisely why the flag is passed anyway. The guard against doing that by accident
/// is in the UI, and the flag records the intent at the point the process is spawned, so a
/// break is distinguishable from an ordinary release in a log even though today it need not be.
#[tauri::command]
pub async fn release_locks(
    app: AppHandle,
    path: String,
    paths: Vec<String>,
    force: bool,
) -> Result<LockOutcome, String> {
    if paths.is_empty() {
        return Ok(LockOutcome::default());
    }
    let cwd = PathBuf::from(path);

    let mut args: Vec<String> = vec!["lock".into(), "release".into()];
    args.extend(paths.iter().cloned());
    if force {
        args.push("--force".into());
    }

    let out = cmd::run(&app, &cwd, args, None).await.map_err(|e| e.to_string())?;
    Ok(parse_lock_report(&out.stdout))
}

/// Which of `paths` are held by somebody other than `identity`.
///
/// Queried without `--branch`: an acquire names no branch either, and the whole-repository
/// query is what matches the question actually being asked. Returns empty on any failure —
/// this only ever *adds* an explanation, so being unable to fetch one must leave the original
/// error standing rather than replace it with a guess.
async fn held_by_others(
    app: &AppHandle,
    cwd: &std::path::Path,
    paths: &[String],
    identity: Option<&str>,
    mut accounts: Vec<KnownIdentity>,
) -> Vec<FileLock> {
    let Ok(all) = cmd::run(app, cwd, vec!["lock".into(), "query".into()], None).await else {
        return Vec::new();
    };

    let me = identity.filter(|s| !s.trim().is_empty());
    if let Some(me) = me {
        if !accounts.iter().any(|a| a.id == me) {
            accounts.push(KnownIdentity { id: me.to_string(), name: me.to_string() });
        }
    }

    let wanted: std::collections::HashSet<&str> = paths.iter().map(|s| s.as_str()).collect();
    let mut held: Vec<FileLock> = parse_locks(&all.stdout)
        .into_iter()
        .filter(|l| wanted.contains(l.path.as_str()))
        .collect();

    attribute(app, cwd, &mut held, None, me, &accounts).await;

    // Ours are not an obstacle: `lock acquire` on a lock we already hold succeeds, so a path
    // that comes back as ours was never the reason the batch failed.
    held.retain(|l| l.mine != Some(true));
    held
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a live host, both shapes in one call.
    const MIXED: &str = "Lock acquired on files:\ntest2.txt\ntest3.txt\nLock already owned on files:\nDaniel/Test.txt\n";

    #[test]
    fn a_batch_that_partly_changed_nothing_is_reported_as_two_lists() {
        let o = parse_lock_report(MIXED);
        assert_eq!(o.acquired, vec!["test2.txt", "test3.txt"]);
        assert_eq!(o.already_owned, vec!["Daniel/Test.txt"]);
        assert!(o.released.is_empty());
    }

    #[test]
    fn re_taking_your_own_lock_is_not_an_acquisition() {
        // The distinction the UI needs: nothing changed on the host, so nothing should be
        // announced as newly yours.
        let o = parse_lock_report("Lock already owned on files:\nDaniel/Test.txt\n");
        assert!(o.acquired.is_empty());
        assert_eq!(o.already_owned, vec!["Daniel/Test.txt"]);
    }

    #[test]
    fn a_release_is_read_from_its_own_section() {
        let o = parse_lock_report("Lock released on files:\ntest2.txt\ntest3.txt\n");
        assert_eq!(o.released, vec!["test2.txt", "test3.txt"]);
        assert!(o.acquired.is_empty());
    }

    #[test]
    fn diagnostics_are_never_mistaken_for_paths() {
        // The failing form, which arrives on the same stream.
        let o = parse_lock_report(
            "Lock acquired on files:\ntest2.txt\n[Error] Failed to lock-acquire 1 batch(es) out of 1\n  at lore-revision/src/lock/file/acquire.rs:41:1\n",
        );
        assert_eq!(o.acquired, vec!["test2.txt"]);
    }

    #[test]
    fn paths_outside_any_section_are_ignored() {
        // A path with no header has no meaning; guessing one would invent a result.
        let o = parse_lock_report("wandering.txt\nLock released on files:\nreal.txt\n");
        assert_eq!(o.released, vec!["real.txt"]);
        assert!(o.acquired.is_empty());
    }

    #[test]
    fn paths_with_spaces_survive() {
        // Asset trees are full of them.
        let o = parse_lock_report("Lock acquired on files:\nArt/Character Rig v2.uasset\n");
        assert_eq!(o.acquired, vec!["Art/Character Rig v2.uasset"]);
    }
}
