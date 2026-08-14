//! Reading working-copy file contents for the viewer.
//!
//! Separate from `repo.rs` because the concerns are different: that module asks `lore`
//! questions, this one reads bytes off disk — and reading bytes is where an artist's
//! repository will hurt you. A single Unreal asset can be hundreds of megabytes, and
//! sending one through the Tauri IPC bridge to be rendered as text would wedge the app.
//!
//! So every read here is bounded, and the bound is reported rather than hidden.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Largest file we will send to the webview as text.
///
/// A source file that exceeds this is not something anyone reads in a diff viewer, and the
/// cost of being wrong is an unresponsive window rather than a slow one.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// Largest image we will inline as a data URI for preview.
///
/// Base64 inflates by a third and the whole thing crosses the IPC bridge, so this is
/// deliberately modest. Larger images report their metadata without a preview.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// How many bytes to sniff when deciding text vs binary by content.
const SNIFF_BYTES: usize = 8000;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileContent {
    Text {
        text: String,
        /// True when the file was cut short at MAX_TEXT_BYTES.
        truncated: bool,
        lines: usize,
    },
    /// An image small enough to show, as a data URI.
    Image {
        data_uri: String,
        size: u64,
    },
    /// Binary, or too large to show. Metadata only — deliberately not a hex dump, which
    /// tells an artist nothing about a mesh.
    Binary {
        size: u64,
        /// Why there is no preview, in the user's terms.
        reason: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct FileMeta {
    pub rel_path: String,
    pub size: u64,
    pub modified_ms: u64,
    pub content: FileContent,
}

/// Resolve a repo-relative path, refusing anything that escapes the repository.
///
/// `rel` arrives from the UI, so this is the boundary that stops a crafted value reading
/// arbitrary files. Canonicalising both sides also collapses `..` and symlinks before the
/// comparison, which a string prefix test would miss.
fn resolve_within(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("{root}: {e}"))?;
    let target = root_path.join(rel);
    let canonical = target
        .canonicalize()
        .map_err(|_| format!("{rel} does not exist in this repository."))?;
    if !canonical.starts_with(&root_path) {
        return Err("That path is outside the repository.".into());
    }
    Ok(canonical)
}

/// Decide text vs binary from the bytes themselves.
///
/// Extension is the fast path elsewhere; this is for everything unnamed or unexpected. A
/// NUL byte in the first few kilobytes is the classic heuristic and is what `file(1)` and
/// git both lean on — cheap, and wrong rarely enough to be worth it.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(SNIFF_BYTES)];
    window.contains(&0)
}

fn image_mime(rel: &str) -> Option<&'static str> {
    let ext = rel.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        // .tga, .exr, .dds and friends are common in game art but no browser renders them;
        // claiming otherwise would show a broken image rather than honest metadata.
        _ => None,
    }
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut v = bytes as f64 / 1024.0;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v < 10.0 {
        format!("{v:.1} {}", units[i])
    } else {
        format!("{} {}", v.round(), units[i])
    }
}

/// Read a working-copy file for display.
#[tauri::command]
pub fn read_file(root: String, rel: String) -> Result<FileMeta, String> {
    let path = resolve_within(&root, &rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;

    if meta.is_dir() {
        return Err("That is a folder, not a file.".into());
    }

    let size = meta.len();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Images first: an artist wants to see the picture, not be told it is binary.
    if let Some(mime) = image_mime(&rel) {
        if size <= MAX_IMAGE_BYTES {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let encoded = base64_encode(&bytes);
            return Ok(FileMeta {
                rel_path: rel,
                size,
                modified_ms,
                content: FileContent::Image {
                    data_uri: format!("data:{mime};base64,{encoded}"),
                    size,
                },
            });
        }
        return Ok(FileMeta {
            rel_path: rel,
            size,
            modified_ms,
            content: FileContent::Binary {
                size,
                reason: format!("Image is {} — too large to preview.", human_size(size)),
            },
        });
    }

    if super::parse::is_binary_extension(&rel) {
        return Ok(FileMeta {
            rel_path: rel,
            size,
            modified_ms,
            content: FileContent::Binary {
                size,
                reason: format!("Binary file, {}.", human_size(size)),
            },
        });
    }

    if size > MAX_TEXT_BYTES {
        return Ok(FileMeta {
            rel_path: rel,
            size,
            modified_ms,
            content: FileContent::Binary {
                size,
                reason: format!("File is {} — too large to display.", human_size(size)),
            },
        });
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Ok(FileMeta {
            rel_path: rel,
            size,
            modified_ms,
            content: FileContent::Binary {
                size,
                reason: format!("Binary file, {}.", human_size(size)),
            },
        });
    }

    // from_utf8_lossy rather than a hard failure: a stray invalid byte in an otherwise
    // readable file should cost that character, not the whole view.
    let text = String::from_utf8_lossy(&bytes).to_string();
    let lines = text.lines().count();

    Ok(FileMeta {
        rel_path: rel,
        size,
        modified_ms,
        content: FileContent::Text { text, truncated: false, lines },
    })
}

/// Minimal base64. Avoids a dependency for the one place we need it.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 test vectors, including the padding cases a hand-rolled encoder gets
        // wrong most often.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes() {
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn nul_bytes_mean_binary() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(b"plain text, no nulls"));
        assert!(!looks_binary(b""));
    }

    #[test]
    fn only_the_sniff_window_is_examined() {
        // A NUL far beyond the window should not change the verdict — the point of a
        // window is a bounded cost on a large file.
        let mut v = vec![b'a'; SNIFF_BYTES + 100];
        v[SNIFF_BYTES + 50] = 0;
        assert!(!looks_binary(&v));
    }

    #[test]
    fn image_mime_only_for_types_a_browser_renders() {
        assert_eq!(image_mime("a/b.png"), Some("image/png"));
        assert_eq!(image_mime("SHOT.JPG"), Some("image/jpeg"));
        // Common in game art, unrenderable in a webview: better to show metadata than a
        // broken image icon.
        assert_eq!(image_mime("tex.tga"), None);
        assert_eq!(image_mime("tex.exr"), None);
        assert_eq!(image_mime("mesh.uasset"), None);
        assert_eq!(image_mime("noextension"), None);
    }

    #[test]
    fn human_size_reads_naturally() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1024 * 1024 * 3 / 2), "1.5 MB");
    }
}
