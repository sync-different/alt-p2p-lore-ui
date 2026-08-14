//! Tests for reading working-copy files.
//!
//! The interesting cases here are all about *refusing* to do something: refusing to render
//! a 300 MB mesh as text, refusing to claim a `.tga` is previewable, refusing to read
//! outside the repository. Those are the paths that turn into an unresponsive window or a
//! security hole, and none of them are exercised by opening a small text file.

use alt_p2p_lore_ui_lib::lore::content::read_file;
use std::fs;
use std::path::PathBuf;

struct TempRepo(PathBuf);

impl TempRepo {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("altlore-read-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".lore")).unwrap();
        TempRepo(dir)
    }
    fn root(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
    fn write(&self, rel: &str, bytes: &[u8]) -> &Self {
        let p = self.0.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
        self
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The serde tag, so assertions read like the UI's discriminated union.
fn kind_of(v: &serde_json::Value) -> &str {
    v["content"]["kind"].as_str().unwrap_or("?")
}

fn read(repo: &TempRepo, rel: &str) -> serde_json::Value {
    let meta = read_file(repo.root(), rel.into()).expect("should read");
    serde_json::to_value(meta).unwrap()
}

#[test]
fn reads_a_text_file() {
    let r = TempRepo::new("text");
    r.write("notes.txt", b"one\ntwo\nthree\n");

    let v = read(&r, "notes.txt");
    assert_eq!(kind_of(&v), "text");
    assert_eq!(v["content"]["lines"], 3);
    assert!(v["content"]["text"].as_str().unwrap().contains("two"));
    assert_eq!(v["size"], 14);
}

#[test]
fn a_file_with_nul_bytes_is_binary_even_with_a_text_extension() {
    // Extension is a hint, not proof. A .txt full of NULs is not something to render.
    let r = TempRepo::new("nul");
    r.write("weird.txt", b"abc\0def");

    let v = read(&r, "weird.txt");
    assert_eq!(kind_of(&v), "binary");
}

#[test]
fn known_binary_extensions_skip_reading_entirely() {
    let r = TempRepo::new("uasset");
    r.write("Content/Hero.uasset", b"plain ascii but still an asset");

    let v = read(&r, "Content/Hero.uasset");
    assert_eq!(kind_of(&v), "binary");
    assert!(v["content"]["reason"].as_str().unwrap().contains("Binary file"));
}

#[test]
fn a_png_comes_back_as_an_inline_preview() {
    let r = TempRepo::new("png");
    // Contents need not be a valid image; what is tested is the routing and encoding.
    r.write("art/icon.png", b"\x89PNG\r\n\x1a\n fake");

    let v = read(&r, "art/icon.png");
    assert_eq!(kind_of(&v), "image");
    let uri = v["content"]["data_uri"].as_str().unwrap();
    assert!(uri.starts_with("data:image/png;base64,"), "got {uri}");
}

#[test]
fn an_unrenderable_image_format_reports_metadata_instead_of_a_broken_preview() {
    // .tga and .exr are everywhere in game art and no browser shows them. Claiming a
    // preview would render a broken-image icon, which is worse than saying nothing.
    let r = TempRepo::new("tga");
    r.write("tex/diffuse.tga", b"\0\0\x02 fake tga");

    let v = read(&r, "tex/diffuse.tga");
    assert_eq!(kind_of(&v), "binary");
}

#[test]
fn a_large_text_file_is_refused_rather_than_sent() {
    // 3 MB of text across the IPC bridge to be syntax-highlighted is how the window stops
    // responding. The limit is 2 MB.
    let r = TempRepo::new("big");
    let big = vec![b'a'; 3 * 1024 * 1024];
    r.write("huge.log", &big);

    let v = read(&r, "huge.log");
    assert_eq!(kind_of(&v), "binary");
    let reason = v["content"]["reason"].as_str().unwrap();
    assert!(reason.contains("too large"), "got {reason}");
    assert!(reason.contains("MB"), "the size should be stated: {reason}");
}

#[test]
fn an_empty_file_is_text_not_binary() {
    let r = TempRepo::new("empty");
    r.write("empty.txt", b"");

    let v = read(&r, "empty.txt");
    assert_eq!(kind_of(&v), "text");
    assert_eq!(v["content"]["lines"], 0);
}

#[test]
fn invalid_utf8_costs_a_character_not_the_view() {
    let r = TempRepo::new("utf8");
    r.write("mixed.txt", b"good \xff bad");

    let v = read(&r, "mixed.txt");
    assert_eq!(kind_of(&v), "text");
    assert!(v["content"]["text"].as_str().unwrap().contains("good"));
}

#[test]
fn refuses_to_read_outside_the_repository() {
    // `rel` comes from the UI; without containment this reads anything the user can.
    let r = TempRepo::new("escape");
    r.write("inside.txt", b"x");

    let err = read_file(r.root(), "../../../../etc/passwd".into()).unwrap_err();
    assert!(
        err.contains("outside the repository") || err.contains("does not exist"),
        "traversal must be refused, got: {err}"
    );
}

#[test]
fn a_missing_file_is_an_error_not_a_panic() {
    let r = TempRepo::new("missing");
    assert!(read_file(r.root(), "nope.txt".into()).is_err());
}

#[test]
fn a_directory_is_rejected_with_a_clear_message() {
    let r = TempRepo::new("dir");
    r.write("sub/file.txt", b"x");

    let err = read_file(r.root(), "sub".into()).unwrap_err();
    assert!(err.contains("folder"), "got {err}");
}

#[test]
fn reports_a_real_modification_time() {
    let r = TempRepo::new("mtime");
    r.write("a.txt", b"x");
    let v = read(&r, "a.txt");
    assert!(v["modified_ms"].as_u64().unwrap() > 0);
}
