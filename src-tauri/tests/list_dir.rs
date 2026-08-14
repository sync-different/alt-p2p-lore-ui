//! Tests for `list_dir`, the working-copy directory listing.
//!
//! These use temporary directories rather than the reference repository, so they run
//! anywhere and do not depend on a 2 GB clone being present. The reference repo is for
//! measuring scale; correctness is pinned here.

use alt_p2p_lore_ui_lib::lore::repo::list_dir;
use std::fs;
use std::path::PathBuf;

/// A throwaway directory tree, removed when the test ends.
struct TempRepo(PathBuf);

impl TempRepo {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("altlore-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".lore")).unwrap();
        TempRepo(dir)
    }
    fn path(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
    fn file(&self, rel: &str, contents: &str) -> &Self {
        let p = self.0.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contents).unwrap();
        self
    }
    fn dir(&self, rel: &str) -> &Self {
        fs::create_dir_all(self.0.join(rel)).unwrap();
        self
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lists_files_and_directories() {
    let r = TempRepo::new("basic");
    r.file("a.txt", "hello").dir("sub").file("sub/b.txt", "world");

    let entries = list_dir(r.path(), String::new()).unwrap();
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"a.txt"));
    assert!(names.contains(&"sub"));
}

#[test]
fn hides_the_lore_store() {
    // .lore is Lore's bookkeeping; showing it invites the user to break their repository.
    let r = TempRepo::new("hides-store");
    r.file("visible.txt", "x");

    let entries = list_dir(r.path(), String::new()).unwrap();
    assert!(!entries.iter().any(|e| e.name == ".lore"), ".lore must not be listed");
}

#[test]
fn directories_sort_before_files_then_case_insensitively() {
    let r = TempRepo::new("sorting");
    r.file("Zebra.txt", "").file("apple.txt", "").dir("Mid").dir("beta");

    let entries = list_dir(r.path(), String::new()).unwrap();
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    // Both directories first, in case-insensitive order, then both files likewise.
    assert_eq!(names, vec!["beta", "Mid", "apple.txt", "Zebra.txt"]);
}

#[test]
fn reports_size_and_marks_binaries() {
    let r = TempRepo::new("meta");
    // Contents are irrelevant here: classification is by extension, which is the point.
    r.file("notes.txt", "12345").file("art.png", "not really a png");

    let entries = list_dir(r.path(), String::new()).unwrap();
    let txt = entries.iter().find(|e| e.name == "notes.txt").unwrap();
    let png = entries.iter().find(|e| e.name == "art.png").unwrap();

    assert_eq!(txt.size, 5);
    assert!(!txt.is_binary);
    assert!(png.is_binary, "extension classification should mark .png binary");
    assert!(txt.modified_ms > 0, "a real mtime should be reported");
}

#[test]
fn relative_paths_use_forward_slashes_and_nest() {
    // These are matched against `lore status` output, which uses forward slashes, so the
    // separator must not vary by platform.
    let r = TempRepo::new("relpaths");
    r.dir("Content/Characters").file("Content/Characters/Hero.uasset", "x");

    let entries = list_dir(r.path(), "Content/Characters".into()).unwrap();
    let hero = entries.iter().find(|e| e.name == "Hero.uasset").unwrap();
    assert_eq!(hero.rel_path, "Content/Characters/Hero.uasset");
    assert!(hero.is_binary);
}

#[test]
fn refuses_to_escape_the_repository() {
    // `rel` comes from the UI. Without the containment check, a crafted value would read
    // anywhere the user's account can.
    let r = TempRepo::new("escape");
    r.file("inside.txt", "x");

    let err = list_dir(r.path(), "../..".into()).unwrap_err();
    assert!(
        err.contains("outside the repository"),
        "traversal must be refused, got: {err}"
    );
}

#[test]
fn a_missing_directory_is_an_error_not_a_panic() {
    let r = TempRepo::new("missing");
    assert!(list_dir(r.path(), "nope/not/here".into()).is_err());
}

#[test]
fn an_empty_directory_lists_nothing() {
    let r = TempRepo::new("empty");
    r.dir("hollow");
    assert!(list_dir(r.path(), "hollow".into()).unwrap().is_empty());
}
