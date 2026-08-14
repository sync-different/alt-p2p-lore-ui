//! Parsers for `lore` CLI output.
//!
//! `lore` has no machine-readable mode — status, branch list and diff are all
//! human-formatted text. Every function here is therefore coupled to how one version of
//! one tool chooses to print, and the client is pinned to `lore 0.8.6+373`.
//!
//! Two consequences are designed for rather than hoped away:
//!
//! - **Pure functions over `&str`.** No process, no filesystem, so every branch is testable
//!   from a recorded fixture. The tests in `tests/parse_golden.rs` run against output
//!   captured verbatim from a real 2 GB repository.
//! - **Unknown lines are skipped, never fatal.** A `lore` upgrade that adds a line should
//!   cost us that line, not the whole listing. What must never be silently wrong is a line
//!   we *do* recognise, which is what the tests pin.

use serde::Serialize;

/// How `lore status` classifies a path.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    /// A code we do not recognise; carried through so the UI can show it rather than
    /// pretend the file is unchanged.
    Other(String),
}

impl ChangeKind {
    fn from_code(code: &str) -> Self {
        match code {
            "A" => ChangeKind::Added,
            "M" => ChangeKind::Modified,
            "D" => ChangeKind::Deleted,
            other => ChangeKind::Other(other.to_string()),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ChangeEntry {
    pub kind: ChangeKind,
    pub path: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct RepoStatus {
    pub repo_id: Option<String>,
    pub branch: Option<String>,
    /// Revision number, e.g. 21.
    pub revision: Option<u64>,
    /// Content hash the revision resolves to.
    pub revision_hash: Option<String>,
    pub changes: Vec<ChangeEntry>,
}

/// Parse `lore status --offline`.
///
/// Shape (verified against a real repository):
/// ```text
/// Repository 019f9e9f8f157e12a7ab77330299cfd4
/// On branch main revision 21 -> 93ba6703...
/// Changes not staged for commit:
/// M Daniel/Test.txt
/// A some/new/file.uasset
/// ```
///
/// Note what a change line does **not** tell you: in the reference repository all 2163
/// files are listed as `M` while `lore diff` reports no differences for any of them — they
/// were marked dirty without their contents changing. Callers must not assume an entry
/// here implies a diff exists.
pub fn parse_status(out: &str) -> RepoStatus {
    let mut status = RepoStatus::default();

    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("Repository ") {
            status.repo_id = Some(rest.trim().to_string());
            continue;
        }

        if let Some(rest) = line.strip_prefix("On branch ") {
            // "main revision 21 -> 93ba67..."
            let mut parts = rest.split_whitespace();
            status.branch = parts.next().map(|s| s.to_string());
            // Walk the remainder rather than indexing fixed positions, so an added word
            // between "branch" and "revision" does not silently shift everything.
            let words: Vec<&str> = rest.split_whitespace().collect();
            if let Some(i) = words.iter().position(|w| *w == "revision") {
                status.revision = words.get(i + 1).and_then(|v| v.parse::<u64>().ok());
                if words.get(i + 2) == Some(&"->") {
                    status.revision_hash = words.get(i + 3).map(|s| s.to_string());
                }
            }
            continue;
        }

        // Section headers such as "Changes not staged for commit:" carry no data we need;
        // the codes on the entries themselves are unambiguous.
        if line.ends_with(':') {
            continue;
        }

        // "M path/with spaces/file.ext" — split once, so paths containing spaces survive.
        if let Some((code, path)) = line.split_once(' ') {
            let code = code.trim();
            let path = path.trim();
            // A single-character code followed by a path. Anything else is prose we do not
            // recognise and deliberately ignore.
            if !code.is_empty() && code.len() <= 2 && !path.is_empty() {
                status.changes.push(ChangeEntry {
                    kind: ChangeKind::from_code(code),
                    path: path.to_string(),
                });
            }
        }
    }

    status
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Branches {
    /// Every distinct branch name, local and remote merged.
    pub names: Vec<String>,
    pub current: Option<String>,
    /// Names that exist only on the host — not yet on this machine.
    pub remote_only: Vec<String>,
}

/// Parse `lore branch list`.
///
/// Two sections, and the second one only appears when connected:
/// ```text
/// Local branches:
///   main
/// * altlore-ui-test
/// Remote branches:
///   main
/// ```
/// The leading `*` marks the checked-out branch.
///
/// The section headers matter. Treating them as noise — which an earlier version did,
/// skipping anything ending in ':' — reads `main` once per section and returns it twice,
/// giving the branch dropdown a duplicate entry and React a repeated key. A repository with
/// a single local branch and no remotes hides this entirely, which is why it survived until
/// a second branch existed.
pub fn parse_branches(out: &str) -> Branches {
    let mut branches = Branches::default();
    let mut in_remote = false;
    let mut local: Vec<String> = Vec::new();
    let mut remote: Vec<String> = Vec::new();

    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.ends_with(':') {
            // Anything that is not explicitly remote counts as local, so an unfamiliar
            // header does not silently move branches into the wrong bucket.
            in_remote = trimmed.to_lowercase().starts_with("remote");
            continue;
        }

        let (is_current, name) = match trimmed.strip_prefix("* ") {
            Some(rest) => (true, rest.trim()),
            None => (false, trimmed),
        };
        if name.is_empty() {
            continue;
        }

        if in_remote {
            remote.push(name.to_string());
        } else {
            local.push(name.to_string());
            if is_current {
                branches.current = Some(name.to_string());
            }
        }
    }

    // Local first, then any remote the user does not have yet. Deduplicated, because the
    // same branch legitimately appears in both sections.
    branches.names = local.clone();
    for r in &remote {
        if !local.contains(r) {
            branches.names.push(r.clone());
            branches.remote_only.push(r.clone());
        }
    }

    branches
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
    /// `@@ -1,3 +1,4 @@`
    HunkHeader,
    /// The `---` / `+++` file headers.
    FileHeader,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct FileDiff {
    /// True when lore reported the file as binary and therefore uncomparable.
    ///
    /// Distinct from `has_changes`: a binary file that genuinely differs has *changed* but
    /// has no lines to show. Conflating the two claims the contents match, which for a
    /// changed asset is the most misleading thing this view could say.
    pub binary: bool,
    /// False when `lore diff` produced nothing.
    ///
    /// This is the common case in a repository where files were marked dirty without being
    /// edited, so it is a normal outcome to render calmly — not an error, and not an empty
    /// view that looks like a failure.
    pub has_changes: bool,
    /// Source revision as printed, e.g. "Daniel/Test.txt@21".
    pub from: Option<String>,
    pub to: Option<String>,
    pub lines: Vec<DiffLine>,
    pub added: usize,
    pub removed: usize,
}

/// Parse unified diff output from `lore diff <path>`.
pub fn parse_diff(out: &str) -> FileDiff {
    let mut diff = FileDiff::default();

    for line in out.lines() {
        // `lore diff` prints this instead of a body when the file is binary. Without an
        // explicit check it falls through to "unrecognised line", the diff looks empty,
        // and a changed asset is reported as unchanged.
        if line.trim() == "Binary files differ" {
            diff.binary = true;
            continue;
        }
        if line.starts_with("--- ") {
            diff.from = Some(line[4..].trim().to_string());
            diff.lines.push(DiffLine { kind: DiffLineKind::FileHeader, text: line.to_string() });
        } else if line.starts_with("+++ ") {
            diff.to = Some(line[4..].trim().to_string());
            diff.lines.push(DiffLine { kind: DiffLineKind::FileHeader, text: line.to_string() });
        } else if line.starts_with("@@") {
            diff.lines.push(DiffLine { kind: DiffLineKind::HunkHeader, text: line.to_string() });
        } else if let Some(rest) = line.strip_prefix('+') {
            diff.added += 1;
            diff.lines.push(DiffLine { kind: DiffLineKind::Added, text: rest.to_string() });
        } else if let Some(rest) = line.strip_prefix('-') {
            diff.removed += 1;
            diff.lines.push(DiffLine { kind: DiffLineKind::Removed, text: rest.to_string() });
        } else if let Some(rest) = line.strip_prefix(' ') {
            diff.lines.push(DiffLine { kind: DiffLineKind::Context, text: rest.to_string() });
        }
        // Anything else — the bare filename line lore prints, blank lines — is not part of
        // the diff body and is skipped.
    }

    // Header lines alone are not a change; only real +/- lines are — or lore telling us
    // the file is binary and differs.
    diff.has_changes = diff.added > 0 || diff.removed > 0 || diff.binary;
    diff
}

/// Classify a path as binary by extension.
///
/// Extension-first because it is instant and correct for the formats an artist actually
/// works in. A content sniff is the fallback for the unknown, done where the bytes are
/// already being read rather than as a separate pass over 2000 files.
pub fn is_binary_extension(path: &str) -> bool {
    const BINARY: &[&str] = &[
        // Unreal and DCC
        "uasset", "umap", "ubulk", "uexp", "blend", "fbx", "obj", "abc", "psd", "ma", "mb",
        // images
        "png", "jpg", "jpeg", "tga", "tif", "tiff", "exr", "hdr", "bmp", "gif", "dds", "ico",
        // audio / video
        "wav", "mp3", "ogg", "flac", "mp4", "mov", "avi", "webm",
        // documents and archives
        "pdf", "docx", "xlsx", "pptx", "zip", "7z", "rar", "gz", "tar",
        // build output
        "dll", "pdb", "exe", "so", "dylib", "lib", "a", "o", "bin", "class", "jar",
    ];
    match path.rsplit_once('.') {
        Some((_, ext)) => BINARY.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileLock {
    pub path: String,
    /// Username of whoever holds it, as lore reports it.
    pub owner: String,
    /// When it was taken, if this came from `lock status`. `lock query` reports the branch
    /// instead, so this is absent there.
    pub since: Option<String>,
}

/// Parse `lore lock query --branch <b>` or `lore lock status <path>`.
///
/// The two commands print the same row shape with a different tail:
/// ```text
/// Locks found:
/// test3.txt by ale on branch e726318bbc3f…
///
/// Files locked for edit:
/// test3.txt by ale on Thu, 13 Aug 2026 17:28:09 +0000
/// ```
///
/// Parsed from the right rather than the left. A path may contain spaces — asset trees are
/// full of them — and may even contain " by ", so splitting forwards would truncate names
/// that are perfectly legal. Anchoring on the last " on " and then the last " by " before
/// it keeps the whole path intact.
pub fn parse_locks(out: &str) -> Vec<FileLock> {
    let mut locks = Vec::new();

    for line in out.lines() {
        let line = line.trim();
        // Both headers end in ':'; blank lines separate nothing of interest.
        if line.is_empty() || line.ends_with(':') {
            continue;
        }

        let Some((left, tail)) = line.rsplit_once(" on ") else { continue };
        let Some((path, owner)) = left.rsplit_once(" by ") else { continue };

        let path = path.trim();
        let owner = owner.trim();
        if path.is_empty() || owner.is_empty() {
            continue;
        }

        // "branch <id>" identifies where the lock lives, not when it was taken — reporting
        // it as a timestamp would put a hash where the UI promises a date.
        let since = if tail.starts_with("branch ") {
            None
        } else {
            Some(tail.trim().to_string())
        };

        locks.push(FileLock { path: path.to_string(), owner: owner.to_string(), since });
    }

    locks
}
