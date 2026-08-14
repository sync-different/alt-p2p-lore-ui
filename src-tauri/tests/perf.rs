//! Performance measurements against a real repository (M2.9).
//!
//! These assert *budgets*, not exact timings — a machine under load must not turn a perf
//! measurement into a red build. The budgets are deliberately several times the observed
//! figures, so they catch an order-of-magnitude regression (an accidental recursive walk,
//! a per-file process spawn) and ignore ordinary variance.
//!
//! Skips when the reference clone is absent. Point elsewhere with `ALT_LORE_TEST_REPO`.
//! Run with `--nocapture` to see the numbers.

use alt_p2p_lore_ui_lib::lore::content::read_file;
use alt_p2p_lore_ui_lib::lore::repo::list_dir;
use std::path::PathBuf;
use std::time::Instant;

fn reference_repo() -> Option<String> {
    let path = std::env::var("ALT_LORE_TEST_REPO").unwrap_or_else(|_| {
        format!("{}/demo-ctone2/demo", std::env::var("HOME").unwrap_or_default())
    });
    if PathBuf::from(&path).join(".lore").is_dir() {
        Some(path)
    } else {
        eprintln!("skipping perf: no repository at {path}");
        None
    }
}

#[test]
fn listing_a_directory_is_fast_enough_to_feel_instant() {
    let Some(repo) = reference_repo() else { return };

    // Warm the filesystem cache first: the question is steady-state responsiveness, not
    // whether the first read hits disk.
    let _ = list_dir(repo.clone(), String::new());

    let mut worst = std::time::Duration::ZERO;
    for _ in 0..20 {
        let start = Instant::now();
        list_dir(repo.clone(), String::new()).expect("root lists");
        worst = worst.max(start.elapsed());
    }

    println!("list_dir(root) worst of 20: {worst:?}");
    // 100ms is the rough threshold at which an interaction stops feeling immediate.
    assert!(worst.as_millis() < 100, "listing felt slow: {worst:?}");
}

#[test]
fn descending_the_tree_stays_cheap_per_level() {
    let Some(repo) = reference_repo() else { return };

    let mut rel = String::new();
    let mut levels = 0;
    let mut total = std::time::Duration::ZERO;

    while levels < 8 {
        let start = Instant::now();
        let Ok(entries) = list_dir(repo.clone(), rel.clone()) else { break };
        total += start.elapsed();

        // Prefer a subdirectory that itself has subdirectories, so the walk actually gets
        // deep. Taking the first directory found stopped after one level in the reference
        // repository — the test passed while measuring almost nothing.
        let next = entries
            .iter()
            .filter(|e| e.is_dir)
            .max_by_key(|e| {
                list_dir(repo.clone(), e.rel_path.clone())
                    .map(|c| c.iter().filter(|x| x.is_dir).count())
                    .unwrap_or(0)
            });
        let Some(next) = next else { break };
        rel = next.rel_path.clone();
        levels += 1;
    }

    assert!(levels >= 3, "only descended {levels} levels — the walk is not exercising depth");

    println!("descended {levels} levels in {total:?}");
    // Lazy expansion means cost tracks depth, not the 1988 directories in the repository.
    // A recursive walk creeping in would blow this budget immediately.
    assert!(total.as_millis() < 500, "descent took {total:?} over {levels} levels");
}

#[test]
fn reading_a_text_file_is_fast() {
    let Some(repo) = reference_repo() else { return };

    let entries = list_dir(repo.clone(), String::new()).expect("root lists");
    let Some(file) = entries
        .iter()
        .find(|e| !e.is_dir && !e.is_binary && e.size > 0)
    else {
        eprintln!("no text file at the root; skipping");
        return;
    };

    let start = Instant::now();
    read_file(repo, file.rel_path.clone()).expect("reads");
    let elapsed = start.elapsed();

    println!("read_file({}) in {elapsed:?}", file.rel_path);
    assert!(elapsed.as_millis() < 200, "reading took {elapsed:?}");
}

#[test]
fn a_large_binary_is_rejected_without_reading_it() {
    let Some(repo) = reference_repo() else { return };

    // Find the biggest binary in the root listing. The guard should refuse it on metadata
    // alone — if this ever starts taking as long as the file is big, something is reading
    // bytes it promised not to.
    let entries = list_dir(repo.clone(), String::new()).expect("root lists");
    let Some(big) = entries
        .iter()
        .filter(|e| !e.is_dir && e.is_binary)
        .max_by_key(|e| e.size)
    else {
        eprintln!("no binary at the root; skipping");
        return;
    };

    let start = Instant::now();
    let meta = read_file(repo, big.rel_path.clone()).expect("reads metadata");
    let elapsed = start.elapsed();

    println!("read_file({}, {} bytes) in {elapsed:?}", big.rel_path, big.size);
    assert!(elapsed.as_millis() < 200, "binary refusal took {elapsed:?}");
    let v = serde_json::to_value(meta).unwrap();
    assert_eq!(v["content"]["kind"], "binary");
}
