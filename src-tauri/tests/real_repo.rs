//! Tests against a real Lore working copy.
//!
//! These skip when the reference clone is absent, so the suite still runs on a machine that
//! does not have a 2 GB repository lying around. Point them elsewhere with
//! `ALT_LORE_TEST_REPO=/path/to/clone`.
//!
//! Their purpose is scale, not correctness: correctness is pinned by the fixture and
//! temp-directory tests, which run everywhere. What only a real repository can tell us is
//! whether listing a directory in a tree of 1988 directories is fast enough to feel
//! instant, and whether the shapes we parse survive contact with real data.

use alt_p2p_lore_ui_lib::lore::repo::list_dir;
use std::path::PathBuf;
use std::time::Instant;

fn reference_repo() -> Option<String> {
    let path = std::env::var("ALT_LORE_TEST_REPO").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/demo-ctone2/demo")
    });
    let p = PathBuf::from(&path);
    if p.join(".lore").is_dir() {
        Some(path)
    } else {
        eprintln!("skipping: no Lore repository at {path}");
        None
    }
}

#[test]
fn lists_the_repository_root_quickly() {
    let Some(repo) = reference_repo() else { return };

    let start = Instant::now();
    let entries = list_dir(repo.clone(), String::new()).expect("root should list");
    let elapsed = start.elapsed();

    assert!(!entries.is_empty(), "the reference repo has files at its root");
    assert!(
        !entries.iter().any(|e| e.name == ".lore"),
        ".lore must stay hidden in a real repo too"
    );
    // Generous: this is one directory read, and the UI does it on every expand.
    assert!(
        elapsed.as_millis() < 500,
        "listing the root took {elapsed:?}, which would be felt as lag"
    );
    println!("root: {} entries in {elapsed:?}", entries.len());
}

#[test]
fn walks_into_a_deep_asset_directory() {
    let Some(repo) = reference_repo() else { return };

    // Descend a few levels the way a user browsing assets would, timing each step.
    let mut rel = String::new();
    let mut depth = 0;
    let start = Instant::now();

    while depth < 6 {
        let entries = match list_dir(repo.clone(), rel.clone()) {
            Ok(e) => e,
            Err(_) => break,
        };
        let Some(next) = entries.iter().find(|e| e.is_dir) else { break };
        rel = next.rel_path.clone();
        depth += 1;
    }

    let elapsed = start.elapsed();
    assert!(depth > 0, "the repository should have at least one subdirectory");
    assert!(
        elapsed.as_millis() < 1000,
        "descending {depth} levels took {elapsed:?}"
    );
    println!("descended {depth} levels to {rel} in {elapsed:?}");
}

#[test]
fn relative_paths_from_a_real_tree_match_status_style_paths() {
    let Some(repo) = reference_repo() else { return };

    let entries = list_dir(repo.clone(), String::new()).expect("root should list");
    let Some(dir) = entries.iter().find(|e| e.is_dir) else { return };
    let children = list_dir(repo, dir.rel_path.clone()).expect("subdir should list");

    for c in children.iter().take(20) {
        assert!(
            c.rel_path.starts_with(&format!("{}/", dir.rel_path)),
            "{} should be nested under {}",
            c.rel_path,
            dir.rel_path
        );
        assert!(
            !c.rel_path.contains('\\'),
            "paths must use forward slashes to match lore status output: {}",
            c.rel_path
        );
    }
}
