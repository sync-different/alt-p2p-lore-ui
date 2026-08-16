//! Live progress for the long, data-moving operations — sync and commit.
//!
//! Unlike clone, sync and commit run through the sidecar without a pseudo-terminal: `lore`
//! prints nothing parseable while they work, so the button sits dead for minutes on a large
//! transfer and the user cannot tell a working sync from a hung one. That was a real report —
//! a multi-GB sync that was moving 12 MB/s looked identical to a crash.
//!
//! There is no `--progress` to switch on, so this measures rather than parses. The only certain
//! signal that the operation is *alive* is the working copy itself changing: for a sync, bytes
//! landing on disk and `.~loretemp` files appearing and resolving as each incoming file is
//! written and renamed into place. A background task walks the working copy every ~800ms and
//! emits bytes-on-disk, in-flight temp-file count, and elapsed time.
//!
//! It is purely observational — it never touches the operation it watches — so a walk that
//! races a rename simply reports a slightly stale number, never an error. Commit's data goes
//! *up* to the host rather than onto local disk, so its bytes stay roughly flat; there the
//! elapsed timer is the signal that carries, and the frontend leans on it accordingly.

use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub const OPERATION_EVENT: &str = "operation://progress";

/// lore writes an incoming file to `name.~loretemp` and renames it into place once complete.
/// Counting these is a direct read of "files currently in flight".
const TEMP_SUFFIX: &str = ".~loretemp";

/// How often the working copy is walked and a progress event emitted.
const TICK: Duration = Duration::from_millis(800);

#[derive(Serialize, Clone, Debug)]
pub struct OperationProgress {
    /// Working-copy path this belongs to, so two operations at once cannot be confused.
    pub path: String,
    /// `"sync"` or `"commit"` — the frontend shows different things for each.
    pub op: String,
    /// Bytes on disk in the working copy (excluding `.lore`). Grows through a sync as files
    /// land; roughly flat through a commit, whose data goes up to the host, not onto disk.
    pub bytes: u64,
    /// `.~loretemp` files present — incoming files being written but not yet renamed into place.
    pub temp_files: u64,
    pub elapsed_ms: u64,
    /// Set once, on the terminal event, when the operation has ended.
    pub done: bool,
}

/// Bytes on disk and in-flight temp-file count under a working copy, in one walk.
///
/// Skips `.lore` (metadata, not the user's data) and is best-effort like clone's `dir_size`:
/// a file that vanishes mid-walk (a `.~loretemp` renamed into place between `read_dir` and
/// `metadata`) is simply not counted, which is correct — it is about to be counted under its
/// final name on the next tick.
fn measure(root: &Path) -> (u64, u64) {
    fn walk(dir: &Path, bytes: &mut u64, temps: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            match entry.metadata() {
                Ok(m) if m.is_dir() => {
                    if name != ".lore" {
                        walk(&entry.path(), bytes, temps);
                    }
                }
                Ok(m) => {
                    // Written blocks, not declared length: sync writes incoming files as
                    // preallocated sparse `.~loretemp` exactly as clone does, so summing `len()`
                    // would snap the counter to the full delta size the instant the files appear
                    // and hold there. See `on_disk_bytes`.
                    *bytes += on_disk_bytes(&m);
                    if name.ends_with(TEMP_SUFFIX) {
                        *temps += 1;
                    }
                }
                Err(_) => {}
            }
        }
    }
    let mut bytes = 0;
    let mut temps = 0;
    walk(root, &mut bytes, &mut temps);
    (bytes, temps)
}

/// Bytes a file actually occupies on disk — blocks written, not declared length.
///
/// lore preallocates each incoming file to its final size as a sparse `.~loretemp` and then
/// fills it, so a half-received 1 GB file reports `len() == 1 GB` while only ~300 MB is written.
/// Both the sync monitor here and clone's `worktree_bytes` must count what has really landed, or
/// their progress snaps to the total the moment the files are created (observed live in clone as
/// 8.9 GB shown against 1.1 GB on disk). `blocks() * 512` is what `du` reports — read directly,
/// not by shelling out — so it is accurate and identical on Linux and macOS.
///
/// Windows has no `st_blocks`, so it falls back to `len()`. That is correct as long as lore's
/// preallocation reserves the clusters (normal NTFS `SetEndOfFile`); if it marks the files
/// sparse there, this would over-count as `len()` did on Unix — `GetCompressedFileSizeW` would
/// be the fix. Unverified on Windows.
#[cfg(unix)]
pub(super) fn on_disk_bytes(m: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.blocks() * 512
}
#[cfg(not(unix))]
pub(super) fn on_disk_bytes(m: &std::fs::Metadata) -> u64 {
    m.len()
}

/// A running progress monitor. From `start()` it emits an `operation://progress` event
/// immediately and then every ~800ms, until `finish()` is called — which stops it promptly
/// (no waiting out a tick) and emits one terminal `done` event carrying the final measurement.
///
/// Dropping without `finish()` (a panic-unwind path) still stops the background task; it just
/// emits no `done`, which the frontend treats the same as any operation that ended without a
/// closing event.
pub struct Monitor {
    app: AppHandle,
    path: String,
    op: String,
    start: Instant,
    stop: Arc<AtomicBool>,
    wake: Arc<Notify>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl Monitor {
    pub fn start(app: AppHandle, path: String, op: impl Into<String>) -> Self {
        let op = op.into();
        let start = Instant::now();
        let stop = Arc::new(AtomicBool::new(false));
        let wake = Arc::new(Notify::new());

        let handle = tokio::spawn({
            let app = app.clone();
            let path = path.clone();
            let op = op.clone();
            let stop = stop.clone();
            let wake = wake.clone();
            async move {
                loop {
                    let (bytes, temp_files) = measure(Path::new(&path));
                    let _ = app.emit(
                        OPERATION_EVENT,
                        OperationProgress {
                            path: path.clone(),
                            op: op.clone(),
                            bytes,
                            temp_files,
                            elapsed_ms: start.elapsed().as_millis() as u64,
                            done: false,
                        },
                    );
                    // Break promptly if finish() already fired while we were measuring — this
                    // is what makes `wake` losing a notification during measure harmless.
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    // Sleep one tick, but cut it short the instant finish() notifies — so a
                    // completed operation flips the UI to done without waiting out the tick.
                    // (Uses `time::timeout` rather than `select!` — the tokio `macros` feature
                    // is not enabled in this build.)
                    let _ = tokio::time::timeout(TICK, wake.notified()).await;
                }
            }
        });

        Monitor { app, path, op, start, stop, wake, handle: Some(handle) }
    }

    /// Stop the monitor and emit the terminal `done` event with the final measurement.
    pub async fn finish(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_waiters();
        if let Some(h) = self.handle.take() {
            let _ = h.await;
        }
        let (bytes, temp_files) = measure(Path::new(&self.path));
        let _ = self.app.emit(
            OPERATION_EVENT,
            OperationProgress {
                path: self.path.clone(),
                op: self.op.clone(),
                bytes,
                temp_files,
                elapsed_ms: self.start.elapsed().as_millis() as u64,
                done: true,
            },
        );
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        // finish() takes the handle, so this only fires on a path that skipped it (a panic
        // unwinding through the operation). Stop the task so it cannot outlive the command.
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_waiters();
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn measure_sums_files_and_counts_temps_skipping_dot_lore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join(".lore")).unwrap();

        fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        fs::write(root.join("sub/b.bin"), vec![0u8; 200]).unwrap();
        // Two files in flight.
        fs::write(root.join("c.bin.~loretemp"), vec![0u8; 50]).unwrap();
        fs::write(root.join("sub/d.bin.~loretemp"), vec![0u8; 10]).unwrap();
        // A large file in .lore that must not be counted, however big.
        fs::write(root.join(".lore/huge"), vec![0u8; 4 * 1024 * 1024]).unwrap();

        let (bytes, temps) = measure(root);
        assert_eq!(temps, 2, "counts .~loretemp files anywhere in the tree");
        // Byte totals are block-based, so exact sums are filesystem-dependent — but four small
        // files can never reach a megabyte, which is how we know the 4 MB .lore file was skipped.
        assert!(bytes > 0, "counts the four working-tree files");
        assert!(bytes < 1024 * 1024, "excludes .lore however large (got {bytes})");
    }

    #[cfg(unix)]
    #[test]
    fn measure_counts_written_blocks_not_the_sparse_preallocation() {
        // Sync's version of the clone bug: incoming files are preallocated to full size as
        // sparse `.~loretemp`, so `len()` would report the whole delta the instant they appear.
        // measure() must count the blocks actually written.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = root.join("big.bin.~loretemp");
        let f = fs::File::create(&path).unwrap();
        f.set_len(200 * 1024 * 1024).unwrap(); // 200 MB logical, sparse
        drop(f);
        let mut w = fs::OpenOptions::new().write(true).open(&path).unwrap();
        w.write_all(&[3u8; 64 * 1024]).unwrap();
        w.flush().unwrap();
        drop(w);

        let (bytes, temps) = measure(root);
        assert_eq!(temps, 1);
        assert!(
            bytes < 8 * 1024 * 1024,
            "sparse temp counted by written blocks, not its 200 MB length (got {bytes})"
        );
    }

    #[test]
    fn measure_of_missing_path_is_zero_not_panic() {
        let (bytes, temps) = measure(Path::new("/no/such/path/at/all"));
        assert_eq!((bytes, temps), (0, 0));
    }

    #[test]
    fn measure_survives_a_tree_being_written_concurrently() {
        // A sync grows the working copy while we walk it. measure() must not panic and must
        // count what has already landed. (The Monitor's live emission needs an AppHandle, so it
        // is exercised end-to-end against the running app rather than here.)
        let dir = tempfile::tempdir().unwrap();
        let writer_dir = dir.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            for i in 0..20 {
                let mut f = fs::File::create(writer_dir.join(format!("f{i}"))).unwrap();
                let _ = f.write_all(&vec![0u8; 1024]);
            }
        });
        writer.join().unwrap();

        let (bytes, _temps) = measure(dir.path());
        assert!(bytes >= 20 * 1024);
    }
}
