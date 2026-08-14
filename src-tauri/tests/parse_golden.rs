//! Golden tests for the `lore` output parsers.
//!
//! `lore` prints for humans, not machines — no `--json` anywhere — so these parsers are
//! coupled to how one version of one tool formats its output. The fixtures in
//! `tests/fixtures/` were captured verbatim from a real 2 GB repository against
//! `lore 0.8.6+373`.
//!
//! The point of pinning them: when `lore` is upgraded and its formatting shifts, a test
//! fails here and names what changed. Without this, the same shift produces an empty file
//! tree or a changes list that silently loses entries — a failure that looks like the
//! repository being fine.
//!
//! Regenerate with `scripts/capture-fixtures.sh` after deliberately adopting a new `lore`.

use alt_p2p_lore_ui_lib::lore::parse::*;

fn fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

// --- status ---------------------------------------------------------------

#[test]
fn status_reads_the_header() {
    let s = parse_status(&fixture("status_header_only.txt"));
    assert_eq!(s.repo_id.as_deref(), Some("019f9e9f8f157e12a7ab77330299cfd4"));
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.revision, Some(21));
    assert_eq!(
        s.revision_hash.as_deref(),
        Some("93ba6703971e4cfdd730bbb5bf3ffba07f9ac7ed0ac6893ab8559dc19989bd73")
    );
    assert!(s.changes.is_empty(), "a header alone lists no changes");
}

#[test]
fn status_reads_change_entries() {
    let s = parse_status(&fixture("status_typical.txt"));
    assert!(!s.changes.is_empty(), "the fixture has change entries");

    let by_path = |p: &str| s.changes.iter().find(|c| c.path == p).cloned();

    let t = by_path("Daniel/Test.txt").expect("Daniel/Test.txt should be listed");
    assert_eq!(t.kind, ChangeKind::Modified);

    // A path with no directory component must parse the same way.
    assert!(by_path("Feedback.txt").is_some());

    // The section header must not become an entry.
    assert!(
        !s.changes.iter().any(|c| c.path.contains("staged for commit")),
        "section headers are not files"
    );
}

#[test]
fn status_keeps_paths_containing_spaces() {
    // Real asset trees are full of these; splitting on every space loses them.
    let s = parse_status("M Content/Character Art/Hero Mesh.uasset");
    assert_eq!(s.changes.len(), 1);
    assert_eq!(s.changes[0].path, "Content/Character Art/Hero Mesh.uasset");
}

#[test]
fn status_carries_unknown_codes_through() {
    // Better to show a code we do not understand than to drop the file and imply it is
    // unchanged.
    let s = parse_status("R old/path.txt");
    assert_eq!(s.changes.len(), 1);
    assert_eq!(s.changes[0].kind, ChangeKind::Other("R".into()));
}

#[test]
fn status_survives_unrecognised_lines() {
    // A future lore may add prose. It should cost that line, not the listing.
    let input = "Repository abc\n\
                 On branch main revision 3 -> deadbeef\n\
                 Some new advisory sentence lore decided to print.\n\
                 M kept.txt\n";
    let s = parse_status(input);
    assert_eq!(s.revision, Some(3));
    assert!(s.changes.iter().any(|c| c.path == "kept.txt"));
}

#[test]
fn status_of_empty_output_is_empty_not_a_panic() {
    let s = parse_status("");
    assert_eq!(s, RepoStatus::default());
}

// --- branches -------------------------------------------------------------

#[test]
fn branches_marks_the_current_one() {
    let b = parse_branches(&fixture("branches_single.txt"));
    assert_eq!(b.names, vec!["main"]);
    assert_eq!(b.current.as_deref(), Some("main"));
}

#[test]
fn branches_handles_several() {
    let b = parse_branches("Local branches:\n* main\n  lighting-pass\n  wip/hero\n");
    assert_eq!(b.names, vec!["main", "lighting-pass", "wip/hero"]);
    assert_eq!(b.current.as_deref(), Some("main"));
}

#[test]
fn branches_without_a_current_marker() {
    let b = parse_branches("Local branches:\n  a\n  b\n");
    assert_eq!(b.names.len(), 2);
    assert_eq!(b.current, None);
}

// --- diff -----------------------------------------------------------------

#[test]
fn diff_reads_a_real_modification() {
    let d = parse_diff(&fixture("diff_text_modified.txt"));
    assert!(d.has_changes);
    assert_eq!(d.added, 1, "the probe appended exactly one line");
    assert_eq!(d.removed, 0);
    assert_eq!(d.from.as_deref(), Some("Daniel/Test.txt@21"));
    assert_eq!(d.to.as_deref(), Some("Daniel/Test.txt"));
    assert!(d.lines.iter().any(|l| l.kind == DiffLineKind::HunkHeader));
    assert!(d.lines.iter().any(|l| l.kind == DiffLineKind::Context));
}

#[test]
fn diff_of_a_dirty_but_identical_file_is_empty() {
    // THE case that matters. In the reference repository every one of 2163 files is listed
    // as modified while producing no diff at all — marked dirty, contents untouched. This
    // must read as "nothing to show", never as a failure.
    let d = parse_diff(&fixture("diff_empty.txt"));
    assert!(!d.has_changes);
    assert_eq!(d.added, 0);
    assert_eq!(d.removed, 0);
    assert!(d.lines.is_empty());
}

#[test]
fn a_changed_binary_is_reported_as_changed_not_identical() {
    // Found by probing a real modified .png: lore prints "Binary files differ" with no
    // hunks. The parser previously skipped that line, reported no changes, and the UI told
    // the user the contents matched — the worst possible answer for a changed asset.
    let d = parse_diff(&fixture("diff_binary_differs.txt"));
    assert!(d.binary, "lore said the file is binary");
    assert!(d.has_changes, "a binary that differs has changed");
    assert_eq!(d.added, 0, "there are no lines to count");
    assert_eq!(d.removed, 0);
}

#[test]
fn an_unchanged_file_is_not_marked_binary() {
    let d = parse_diff(&fixture("diff_empty.txt"));
    assert!(!d.binary);
    assert!(!d.has_changes);
}

#[test]
fn a_text_diff_is_not_marked_binary() {
    let d = parse_diff(&fixture("diff_text_modified.txt"));
    assert!(!d.binary);
    assert!(d.has_changes);
}

#[test]
fn diff_counts_additions_and_removals_separately() {
    let input = "--- a@1\n+++ a\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
    let d = parse_diff(input);
    assert_eq!(d.added, 1);
    assert_eq!(d.removed, 1);
    assert!(d.has_changes);
}

#[test]
fn diff_headers_alone_are_not_a_change() {
    // Headers with no +/- body must not be reported as a modification.
    let d = parse_diff("--- a@1\n+++ a\n");
    assert!(!d.has_changes);
}

#[test]
fn diff_strips_the_marker_but_keeps_the_text() {
    let d = parse_diff("@@ -1 +1 @@\n+hello world\n");
    let added: Vec<_> = d.lines.iter().filter(|l| l.kind == DiffLineKind::Added).collect();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].text, "hello world", "the leading + is a marker, not content");
}

#[test]
fn diff_keeps_content_that_begins_with_a_marker() {
    // A removed line whose text itself starts with '-' must not lose a character.
    let d = parse_diff("@@ -1 +1 @@\n--minus-prefixed\n");
    let removed: Vec<_> = d.lines.iter().filter(|l| l.kind == DiffLineKind::Removed).collect();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].text, "-minus-prefixed");
}

// --- binary classification -------------------------------------------------

#[test]
fn binary_extensions_cover_what_artists_use() {
    for p in [
        "Content/Hero.uasset",
        "Maps/Level.umap",
        "tex/diffuse.PNG",     // case-insensitive
        "audio/step.wav",
        "docs/spec.pdf",
        "Binaries/Win64/UnrealEditor.dll",
    ] {
        assert!(is_binary_extension(p), "{p} should be binary");
    }
}

#[test]
fn text_files_are_not_binary() {
    for p in ["a.txt", "src/main.rs", "config.json", "notes.md", "Makefile", "no_extension"] {
        assert!(!is_binary_extension(p), "{p} should be text");
    }
}

#[test]
fn a_dot_in_a_directory_name_does_not_confuse_classification() {
    // "my.assets/notes.txt" ends in .txt, not .assets.
    assert!(!is_binary_extension("my.assets/notes.txt"));
}

// --- locks ----------------------------------------------------------------

#[test]
fn locks_query_reads_owner_and_path() {
    let l = parse_locks(&fixture("locks_query.txt"));
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].path, "test3.txt");
    assert_eq!(l[0].owner, "ale");
    // `lock query` reports the branch, not a time — it must not be presented as one.
    assert_eq!(l[0].since, None);
}

#[test]
fn lock_status_reads_the_time_it_was_taken() {
    let l = parse_locks(&fixture("lock_status.txt"));
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].owner, "ale");
    assert_eq!(l[0].since.as_deref(), Some("Thu, 13 Aug 2026 17:28:09 +0000"));
}

#[test]
fn no_locks_is_an_empty_list_not_a_parse_failure() {
    // The ordinary case: a header with nothing under it.
    assert!(parse_locks(&fixture("locks_query_empty.txt")).is_empty());
    assert!(parse_locks("").is_empty());
}

#[test]
fn a_locked_path_containing_spaces_survives() {
    // Asset trees are full of these, and parsing forwards would truncate the name.
    let l = parse_locks("Locks found:\nContent/Character Art/Hero Mesh.uasset by daniel on branch abc\n");
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].path, "Content/Character Art/Hero Mesh.uasset");
    assert_eq!(l[0].owner, "daniel");
}

#[test]
fn a_path_containing_the_word_by_is_not_split_early() {
    // "Standby" and "Flyby" are ordinary asset names; anchoring on the last " by " is what
    // keeps them whole.
    let l = parse_locks("Locks found:\nContent/Standby by Sea.uasset by win on branch abc\n");
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].path, "Content/Standby by Sea.uasset");
    assert_eq!(l[0].owner, "win");
}

#[test]
fn several_locks_are_all_returned() {
    let l = parse_locks(
        "Locks found:\na.uasset by ale on branch x\nb.uasset by daniel on branch x\n",
    );
    assert_eq!(l.len(), 2);
    assert_eq!(l[1].owner, "daniel");
}

#[test]
fn a_malformed_lock_line_is_skipped_not_fatal() {
    let l = parse_locks("Locks found:\nthis line makes no sense\nok.txt by ale on branch x\n");
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].path, "ok.txt");
}

#[test]
fn branches_does_not_duplicate_a_branch_present_locally_and_remotely() {
    // Found the moment a second branch existed: `main` appears under both headers, and
    // ignoring the headers returned it twice — a duplicate row in the dropdown and a
    // repeated React key.
    let b = parse_branches(&fixture("branches_multiple.txt"));
    assert_eq!(b.names, vec!["main", "altlore-ui-test"]);
    assert_eq!(b.current.as_deref(), Some("altlore-ui-test"));
    assert!(b.remote_only.is_empty(), "both branches exist locally");
}

#[test]
fn branches_reports_one_that_exists_only_on_the_host() {
    let b = parse_branches(
        "Local branches:\n* main\nRemote branches:\n  main\n  lighting-pass\n",
    );
    assert_eq!(b.names, vec!["main", "lighting-pass"]);
    assert_eq!(b.remote_only, vec!["lighting-pass"]);
}

#[test]
fn branches_offline_output_still_parses() {
    // Disconnected there is no remote section at all.
    let b = parse_branches(&fixture("branches_local_only.txt"));
    assert!(b.names.contains(&"main".to_string()));
    assert!(b.remote_only.is_empty());
}

#[test]
fn the_current_marker_is_only_honoured_in_the_local_section() {
    // A remote listing has no checked-out branch; taking a marker there would report a
    // branch as current that this machine does not have.
    let b = parse_branches("Local branches:\n  main\nRemote branches:\n* other\n");
    assert_eq!(b.current, None);
}

/// A repository that has just been created: revision 0, no files, nothing committed.
///
/// Captured from `atlas` on a second host built for testing two hosts at once. It matters
/// because it is the state every new repository starts in, and the UI has to tell it apart
/// from a folder that happens to be empty — one is normal, the other sounds like a fault.
#[test]
fn an_empty_repository_parses_as_revision_zero_and_no_changes() {
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/status_empty_repository.txt"),
    )
    .unwrap();
    let status = alt_p2p_lore_ui_lib::lore::parse::parse_status(&text);

    assert_eq!(status.revision, Some(0));
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert!(status.changes.is_empty(), "nothing has been committed, so nothing can have changed");
}
