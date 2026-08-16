//! Cloning a repository, with the identity it will act as.
//!
//! Streamed rather than awaited: a clone of a real repository moves gigabytes and takes
//! minutes, and a dialog that sits inert for that long is indistinguishable from one that has
//! hung. Each line the CLI prints is forwarded to the UI as it arrives.
//!
//! The identity matters here more than anywhere else. `lore` records the identity a clone was
//! made with into that working copy's `.lore/config.toml`, which is what makes two clones of
//! one repository act as two different people — so choosing it at clone time is choosing it
//! permanently, and the app writes it explicitly rather than hoping the CLI infers it.

use super::cmd::redact;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const CLONE_EVENT: &str = "clone://progress";

#[derive(Serialize, Clone, Debug)]
pub struct CloneProgress {
    /// The clone this line belongs to, so two at once cannot be confused.
    pub id: String,
    pub line: String,
    /// A percentage, when the CLI gave us one. Absent is normal and must not read as 0%.
    pub percent: Option<f32>,
    /// Bytes on disk in the destination so far.
    ///
    /// Measured rather than reported: a progress bar drawn with carriage returns renders on a
    /// terminal and emits nothing useful through a pipe, so the only certain signal that a
    /// clone is *moving* is the working copy growing. It cannot give a percentage — the total
    /// is unknown — but "412 MB and climbing" is the difference between waiting and wondering.
    pub bytes: Option<u64>,
    /// The clone's own total, once the bar has reported one.
    pub total_bytes: Option<u64>,
    pub files_done: Option<u64>,
    /// A floor while `files_growing` is true — lore is still discovering files.
    pub files_total: Option<u64>,
    pub files_growing: Option<bool>,
    /// How long the clone took, from its own closing line.
    pub seconds: Option<f32>,
    /// Set once, when the process has ended.
    pub done: Option<bool>,
    pub error: Option<String>,
}

/// One redraw of `lore clone`'s progress bar.
///
/// The bar is drawn **only for an interactive terminal**. There is no flag to force it — the
/// CLI reference has no `--progress`, and the presence of `--non-interactive` says the gate is
/// an interactivity check. Piped, `lore clone` prints five lines and says nothing for the 99
/// seconds in between. So the app gives it a pseudo-terminal and reads the bar it draws:
///
/// ```text
/// [█████████████       ] 536/818+  128.92 MiB/1.85 GiB
/// ```
///
/// The `+` on the file total means lore is still discovering files, so that number may grow.
/// The percentage is taken from **bytes**, which do not move backwards.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CloneFrame {
    pub files_done: u64,
    pub files_total: u64,
    /// True when the total carried a `+` — still counting, so it is a floor and not a total.
    pub files_growing: bool,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl CloneFrame {
    pub fn percent(&self) -> Option<f32> {
        (self.bytes_total > 0)
            .then(|| (self.bytes_done as f64 / self.bytes_total as f64 * 100.0) as f32)
            .map(|p| p.clamp(0.0, 100.0))
    }
}

/// Strip ANSI escapes, which the bar is wrapped in when drawn to a terminal.
fn without_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI ... final byte in @-~; anything else we skip one char and carry on.
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// `128.92 MiB` → bytes.
fn parse_size(text: &str) -> Option<u64> {
    let t = text.trim();
    let split = t.find(|c: char| c.is_alphabetic())?;
    let (value, unit) = t.split_at(split);
    let value: f64 = value.trim().parse().ok()?;
    let scale: f64 = match unit.trim() {
        "B" => 1.0,
        "KiB" | "KB" => 1024.0,
        "MiB" | "MB" => 1024.0 * 1024.0,
        "GiB" | "GB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" | "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * scale) as u64)
}

/// Read one redraw of the bar, if this text is one.
pub fn parse_frame(line: &str) -> Option<CloneFrame> {
    let clean = without_ansi(line);
    // Everything after the bar itself. Without a bracket this is not a progress frame — the
    // header lines contain slashes and sizes too, and must not be mistaken for one.
    let rest = clean.rsplit_once(']')?.1.trim();

    let mut parts = rest.split_whitespace();
    let files = parts.next()?;
    let (files_done, files_rest) = files.split_once('/')?;
    let files_growing = files_rest.ends_with('+');
    let files_total = files_rest.trim_end_matches('+');

    // "128.92 MiB/1.85 GiB" — rejoined, because the sizes contain spaces.
    let sizes: String = parts.collect::<Vec<_>>().join(" ");
    let (done, total) = sizes.split_once('/')?;

    Some(CloneFrame {
        files_done: files_done.trim().parse().ok()?,
        files_total: files_total.trim().parse().ok()?,
        files_growing,
        bytes_done: parse_size(done)?,
        bytes_total: parse_size(total)?,
    })
}

/// The two lines `lore clone` prints when it finishes:
///
/// ```text
/// Cloned 2157/2157 files (2.00 GiB/2.00 GiB)
/// Clone complete in 99.95s
/// ```
///
/// Read rather than measured, because these are the clone's own numbers. The app used to
/// build its summary from React state captured before the clone began, and reported zeroes
/// next to a console box showing the real totals.
pub fn parse_summary(line: &str) -> Option<(u64, u64)> {
    let clean = without_ansi(line);
    let rest = clean.trim().strip_prefix("Cloned ")?;
    let (files, sizes) = rest.split_once(" files (")?;
    let files_total = files.split('/').nth(1)?.trim_end_matches('+');
    let sizes = sizes.strip_suffix(')')?;
    let bytes_total = sizes.split_once('/')?.1;
    Some((files_total.trim().parse().ok()?, parse_size(bytes_total)?))
}

/// Seconds from `Clone complete in 99.95s`.
pub fn parse_duration(line: &str) -> Option<f32> {
    let clean = without_ansi(line);
    let rest = clean.trim().strip_prefix("Clone complete in ")?;
    rest.trim_end_matches('s').trim().parse().ok()
}

/// A percentage from a progress line, if there is one.
///
/// Deliberately narrow: the *last* number followed by `%`, and only when it is a sane
/// percentage. Guessing at richer formats without having seen them would be inventing a
/// protocol — and a wrong percentage is worse than none, because it looks authoritative.
pub fn percent_of(line: &str) -> Option<f32> {
    let idx = line.rfind('%')?;
    let head = &line[..idx];
    // The byte *after* the last non-number character — advanced by that character's own
    // width, not by 1. `rfind` returns a byte index, and `i + 1` lands inside a multibyte
    // char (`é50%` panicked with "byte index is not a char boundary"). char_indices gives the
    // width, so the slice always starts on a boundary.
    let start = head
        .char_indices()
        .rev()
        .find(|(_, c)| !(c.is_ascii_digit() || *c == '.'))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let value: f32 = head[start..].parse().ok()?;
    (0.0..=100.0).contains(&value).then_some(value)
}

/// Bytes under a directory. Best effort: a file that vanishes mid-walk is simply not counted.
fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    let mut total = 0;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(m) if m.is_dir() => total += dir_size(&entry.path()),
            Ok(m) => total += m.len(),
            Err(_) => {}
        }
    }
    total
}

/// Working-tree bytes on disk in the clone destination, excluding the `.lore` store.
///
/// The honest progress signal, and the reason a whole sampler exists to call it: lore's own bar
/// counts a file's bytes only once it is *complete* and renamed out of `.~loretemp`, so with
/// several multi-GB files downloading at once the bar sits far behind what is truly on disk
/// (observed: 1.8 GB reported against 9.1 GB written, frozen at 21% for minutes). The
/// `.~loretemp` files are in the working tree, so they are counted here — by their *written*
/// blocks (see `on_disk_bytes`), which is what makes the number climb with the download rather
/// than snap to the preallocated total.
fn worktree_bytes(dest: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(m) if m.is_dir() => walk(&entry.path(), total),
                Ok(m) => *total += super::progress::on_disk_bytes(&m),
                Err(_) => {}
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(dest) else { return 0 };
    let mut total = 0;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(m) if m.is_dir() => {
                // Skip the fragment/metadata store; it is not the data the user is receiving,
                // and on a shared-store clone it would double-count against the working tree.
                if entry.file_name() != ".lore" {
                    walk(&entry.path(), &mut total);
                }
            }
            Ok(m) => total += super::progress::on_disk_bytes(&m),
            Err(_) => {}
        }
    }
    total
}

fn emit(app: &AppHandle, p: CloneProgress) {
    let _ = app.emit(CLONE_EVENT, p);
}

/// Remove the partial output of a failed clone. Returns whether anything was removed.
///
/// `preexisted` is the folder's state *before* this clone ran, captured while the guards had
/// just proven it was absent-or-empty. That is what makes this safe: we are not guessing
/// whether the directory is ours, we recorded it.
///
/// - **created by us** (`!preexisted`): remove the whole directory.
/// - **an empty folder the user made** (`preexisted`): remove its *contents* but keep the
///   folder — a directory the user chose and may care about (its name, its place) is not ours
///   to delete, only what we wrote into it.
///
/// Refuses if a `.lore` is somehow absent — nothing failed the way we expect, so removing
/// anything would be acting on a state we do not understand. Every filesystem error is
/// swallowed: cleanup is best-effort, and a failure to tidy up must not replace the real
/// error (the network drop) with a permission complaint.
fn clean_up_partial(dest: &std::path::Path, preexisted: bool) -> bool {
    // Only ever touch a directory that carries the mark of an interrupted clone. If there is
    // no `.lore`, lore failed before writing anything and there is nothing of ours to remove.
    if !dest.join(".lore").is_dir() {
        return false;
    }

    if !preexisted {
        return std::fs::remove_dir_all(dest).is_ok();
    }

    // The user's own empty folder: clear its contents, keep the folder.
    let Ok(entries) = std::fs::read_dir(dest) else { return false };
    let mut removed_any = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let ok = match entry.file_type() {
            Ok(t) if t.is_dir() => std::fs::remove_dir_all(&path).is_ok(),
            _ => std::fs::remove_file(&path).is_ok(),
        };
        removed_any |= ok;
    }
    removed_any
}

/// Clone `url` into `dest`, acting as `identity` if one is given.
///
/// Returns when the clone has finished, so the caller knows whether to add a workspace — but
/// progress arrives on `clone://progress` throughout.
#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    id: String,
    url: String,
    dest: String,
    identity: Option<String>,
    shared_store: Option<bool>,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("The repository address is required.".into());
    }
    let dest_path = std::path::PathBuf::from(&dest);
    // Checked here rather than left to `lore`, which would run for a while first and then
    // fail on a condition that was knowable immediately.
    if dest_path.join(".lore").is_dir() {
        return Err(format!("{dest} is already a Lore repository."));
    }
    if dest_path.is_dir()
        && std::fs::read_dir(&dest_path).map(|mut d| d.next().is_some()).unwrap_or(false)
    {
        return Err(format!("{dest} is not empty. Choose an empty folder, or a new one."));
    }

    // Whether the folder existed before this clone touched it. The guards above have already
    // established the only two possibilities — absent, or present-and-empty — so this single
    // bool is enough to decide, on failure, exactly what is safe to remove: everything, if we
    // created the folder; only its contents, if the user made an empty folder and pointed us
    // at it. A directory the user chose is never removed, only what the clone wrote into it.
    let dest_preexisted = dest_path.is_dir();

    let mut args: Vec<String> = vec!["clone".into(), url.trim().to_string(), dest.clone()];
    if let Some(ref who) = identity {
        args.push("--identity".into());
        args.push(who.clone());
    }
    // Instances on one machine can share their immutable fragment store — which is how the
    // system is designed, and what makes a second clone of a 2 GiB repository cost a fraction
    // of the first in both time and disk. Off by default: it is a machine-wide store, and
    // opting a working copy into shared storage is a decision, not a default.
    if shared_store == Some(true) {
        args.push("--use-shared-store".into());
    }
    eprintln!("cloning: lore {}", redact(&args));

    // A pseudo-terminal, so lore draws its progress bar. See `parse_frame`.
    let exe = lore_binary(&app)?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PtyLine>();
    let args_for_thread = args.clone();
    let cwd_for_thread = std::env::temp_dir();

    let worker = tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        pump_pty(exe, &args_for_thread, cwd_for_thread, tx)
    });

    // Measure bytes on disk on a timer, and let *that* drive the byte count, rate and percent —
    // not lore's bar, which counts only completed files and so undercounts badly (see
    // `worktree_bytes`). The bar still supplies the total and the file counts below; this only
    // takes over the "how much has arrived" number. Stops when the pump loop ends.
    let sampler_stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let app = app.clone();
        let id = id.clone();
        let dest_path = dest_path.clone();
        let stop = sampler_stop.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                emit(
                    &app,
                    CloneProgress {
                        id: id.clone(),
                        line: String::new(),
                        // No percent: the frontend derives it from these bytes against the bar's
                        // total, so there is one source of truth for "how far along".
                        percent: None,
                        bytes: Some(worktree_bytes(&dest_path)),
                        total_bytes: None,
                        files_done: None,
                        files_total: None,
                        files_growing: None,
                        seconds: None,
                        done: None,
                        error: None,
                    },
                );
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
        })
    };

    let mut tail: Vec<String> = Vec::new();
    while let Some(PtyLine(line)) = rx.recv().await {
        let line = line.trim_end().to_string();
        if let Some(frame) = parse_frame(&line) {
            emit(
                &app,
                CloneProgress {
                    id: id.clone(),
                    // The bar itself is redrawn constantly; showing it as a log line would
                    // scroll the useful output away. The numbers carry it instead.
                    line: String::new(),
                    // Byte count and percent come from the disk sampler, not from here: the
                    // bar's `bytes_done` counts only completed files and lags the truth by
                    // gigabytes while big files are in flight. The bar's *total* and *file
                    // counts*, though, are exactly right and are what the sampler cannot know.
                    percent: None,
                    bytes: None,
                    total_bytes: Some(frame.bytes_total),
                    files_done: Some(frame.files_done),
                    files_total: Some(frame.files_total),
                    files_growing: Some(frame.files_growing),
                    seconds: None,
                        done: None,
                    error: None,
                },
            );
            continue;
        }
        tail.push(line.clone());
        if tail.len() > 40 {
            tail.remove(0);
        }
        // Route the meaningful text lines (not the constantly-redrawn bar, which took the
        // branch above and never reaches here) onto the shared console stream, so a clone
        // narrates itself in the debug console the way commit/sync now do through `cmd::run`.
        // Stripped of ANSI first: this is raw pseudo-terminal output, and the closing lines
        // carry erase codes — the same `␛[2K` leak the error tail already had to fix. A line
        // that is *only* an erase code becomes empty here and is rightly dropped.
        let plain = without_ansi(&line);
        if !plain.trim().is_empty() {
            super::cmd::emit_line(&app, "clone", "out", plain.trim());
        }
        emit(
            &app,
            CloneProgress {
                id: id.clone(),
                percent: percent_of(&line),
                line,
                bytes: None,
                total_bytes: None,
                files_done: None,
                files_total: None,
                files_growing: None,
                seconds: None,
                        done: None,
                error: None,
            },
        );
    }

    // The pump has ended, so the clone process has closed its pseudo-terminal: stop the disk
    // sampler before reading the exit code, so it cannot emit a stray byte sample after the
    // final `done`. It checks the flag once per loop, so this returns within one tick.
    sampler_stop.store(true, Ordering::Relaxed);
    let _ = sampler.await;

    let code = worker
        .await
        .map_err(|e| format!("The clone task failed ({e})."))??;

    // The clone's own totals, from the lines it prints last.
    let summary = tail.iter().rev().find_map(|l| parse_summary(l));
    let seconds = tail.iter().rev().find_map(|l| parse_duration(l));

    let ok = code == 0;
    let error = (!ok).then(|| {
        // Strip ANSI, and drop the blank/erase-only lines it leaves behind. The tail is raw
        // pseudo-terminal output — lore draws its progress bar with escape codes — so an
        // untouched line reached the user as `…blob-500mb.bin␛[0m` with a stray `␛[2K` on its
        // own line. `without_ansi` already exists for the progress parser; the error path
        // simply never used it.
        let why = tail
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(|l| without_ansi(l).trim().to_string())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if why.is_empty() {
            format!("The clone stopped unexpectedly (exit code {code}).")
        } else {
            why
        }
    });

    // A clone that failed — a dropped network at 80%, most often — leaves a half-written
    // directory with a `.lore/` in it. That is a dead end: `lore clone` has no resume, and
    // `--force` will not reuse it (both verified), so a retry into the same folder is refused
    // by lore *and* by the guard above, while `is_lore_repo` reports it valid and `open_repo`
    // then fails with a cryptic "Repository not found". The only escape was deleting the folder
    // by hand, which the app never mentioned. So the partial download is removed here, and the
    // error says so, turning a dead end into a one-press retry.
    //
    // Scoped precisely: only what the clone wrote. If we created the folder, the whole thing
    // goes; if the user pointed us at an empty folder they made, its *contents* go but the
    // folder stays — we never delete a directory the user chose.
    let error = error.map(|why| {
        let removed = clean_up_partial(&dest_path, dest_preexisted);
        if removed {
            format!(
                "{why}\n\nThe interrupted download has been removed. Press Clone to try again."
            )
        } else {
            why
        }
    });
    emit(
        &app,
        CloneProgress {
            id: id.clone(),
            line: if ok { "Done.".into() } else { "Failed.".into() },
            percent: ok.then_some(100.0),
            // Its numbers if it gave them, the folder on disk only as a last resort.
            bytes: Some(summary.map(|(_, b)| b).unwrap_or_else(|| dir_size(&dest_path))),
            total_bytes: summary.map(|(_, b)| b),
            files_done: summary.map(|(f, _)| f),
            files_total: summary.map(|(f, _)| f),
            files_growing: None,
            // `parse_duration` had a test and no caller that kept its answer: this read
            // `seconds: None` while the value sat computed and unused two lines above, so
            // the summary never showed how long the clone took. The compiler said so, as an
            // unused-variable warning that had become part of the scenery.
            seconds,
            done: Some(ok),
            error: error.clone(),
        },
    );
    match error {
        None => Ok(dest),
        Some(e) => Err(e),
    }
}

/// Run a command under a pseudo-terminal, forwarding each `\r`- or `\n`-terminated piece.
///
/// Split out from `clone_repo` so the part that is genuinely hard — knowing when a
/// pseudo-terminal has finished — can be tested against a trivial command, with no host, no
/// repository and no `lore`. That distinction is the whole reason this function exists:
/// the reading was never the fragile part, the *ending* was.
fn pump_pty(
    exe: std::path::PathBuf,
    args: &[String],
    cwd: std::path::PathBuf,
    tx: tokio::sync::mpsc::UnboundedSender<PtyLine>,
) -> Result<i32, String> {
    use portable_pty::{CommandBuilder, PtySize};
    let pty = portable_pty::native_pty_system()
        .openpty(PtySize {
            // Wide enough that the bar is not truncated, and a fixed size because nothing
            // is resizing this terminal.
            cols: 120,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open a terminal for the clone ({e})."))?;

    let mut cmd = CommandBuilder::new(exe);
    for a in args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    // Without a sane TERM some progress libraries stay silent, which is the whole point
    // of going to this trouble.
    cmd.env("TERM", "xterm-256color");

    let mut child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Lore could not be started ({e})."))?;
    drop(pty.slave);

    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read the clone's output ({e})."))?;

    // Reading to EOF is enough on Unix: the last slave descriptor closing ends the
    // stream, so the loop below finishes on its own when `lore` exits.
    //
    // **ConPTY does not do that.** conhost keeps the master readable after the child has
    // gone, so the read blocks forever, `tx` is never dropped, the `rx.recv()` loop never
    // ends, and the `done` event at the bottom of this function is never emitted. The
    // clone itself is entirely fine — observed finishing in 0.08s, every line parsed and
    // displayed, and the button still saying "Cloning…". Waiting on the child separately
    // and *closing the master* is what ends the read.
    let master = pty.master;
    let waiter = std::thread::spawn(move || {
        let status = child.wait();
        // The child has exited, but conhost may still be holding what it wrote last —
        // and the last thing `lore clone` prints is precisely the summary this parses
        // for the file and byte totals. Closing immediately would truncate exactly the
        // part that is read, so let the reader drain first.
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(master);
        status
    });

    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    loop {
        match std::io::Read::read(&mut reader, &mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                // Split on BOTH: the bar redraws with a carriage return and never a
                // newline, so waiting for lines would mean waiting for the whole clone.
                while let Some(i) = pending.find(['\r', '\n']) {
                    let piece = pending[..i].to_string();
                    pending.drain(..=i);
                    if !piece.trim().is_empty() {
                        let _ = tx.send(PtyLine(piece));
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !pending.trim().is_empty() {
        let _ = tx.send(PtyLine(pending.clone()));
    }

    let status = waiter
        .join()
        .map_err(|_| "The clone's exit could not be observed.".to_string())?
        .map_err(|e| format!("The clone could not be waited on ({e})."))?;
    Ok(status.exit_code() as i32)
}

/// One piece of terminal output, split on a newline *or* a carriage return.
struct PtyLine(String);

/// The bundled `lore`, or whatever is on PATH in development.
///
/// The sidecar sits next to the app's own executable; resolving it by hand rather than through
/// the shell plugin because that plugin does not offer a terminal, which is the entire reason
/// this path exists.
/// The file name `lore` actually has on this platform.
///
/// Everywhere else the shell plugin appends this for us — `sidecar("lore")` finds
/// `lore.exe` on Windows without being told. This path resolves the binary by hand, so it
/// is the one place that has to know, and hardcoding the Unix name here meant clone was the
/// only broken command on Windows while every other call worked.
const LORE_EXE: &str = if cfg!(windows) { "lore.exe" } else { "lore" };

fn lore_binary(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(found) = lore_in_dir(dir) {
                return Ok(found);
            }
        }
    }
    let _ = app;
    // Development: `cargo tauri dev` does not stage sidecars beside the binary.
    which_on_path(LORE_EXE).ok_or_else(|| {
        "The bundled Lore program could not be found next to the app.".to_string()
    })
}

/// `lore` inside one directory, under whatever name it goes by here.
fn lore_in_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let candidate = dir.join(LORE_EXE);
    candidate.is_file().then_some(candidate)
}

fn which_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::percent_of;

    #[cfg(unix)]
    #[test]
    fn worktree_counts_written_blocks_not_preallocated_length() {
        // The b12 clone bug, pinned: lore preallocates each incoming file to its final size as
        // a sparse `.~loretemp`, so `len()` reports the full size while almost nothing is
        // written. Summing `len()` snapped the progress counter to the repo's total the instant
        // the files appeared (8.9 GB shown against 1.1 GB on disk). `worktree_bytes` must count
        // the blocks actually written instead.
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("bigfiles")).unwrap();
        let path = root.join("bigfiles/x.bin.~loretemp");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(200 * 1024 * 1024).unwrap(); // 200 MB logical, sparse
        drop(f);
        // Write only a little real data.
        let mut w = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        w.write_all(&[7u8; 64 * 1024]).unwrap();
        w.flush().unwrap();
        drop(w);

        let bytes = super::worktree_bytes(root);
        assert!(
            bytes < 8 * 1024 * 1024,
            "counted {bytes} bytes — expected the written blocks (~KB), not the 200 MB preallocation"
        );
    }

    #[test]
    fn reads_a_percentage_when_one_is_printed() {
        assert_eq!(percent_of("Downloading 42% ..."), Some(42.0));
        assert_eq!(percent_of("  73.5% done"), Some(73.5));
        assert_eq!(percent_of("100%"), Some(100.0));
    }

    #[test]
    fn takes_the_last_percentage_on_a_line() {
        // Progress lines often carry a total and a current; the rightmost is the one moving.
        assert_eq!(percent_of("files 100% · bytes 12%"), Some(12.0));
    }

    #[test]
    fn refuses_a_number_that_cannot_be_a_percentage() {
        // A wrong percentage is worse than none: it looks authoritative and a bar that reads
        // 400% or -1% destroys trust in the whole dialog.
        assert_eq!(percent_of("420%"), None);
        assert_eq!(percent_of("cpu load 3%%"), None);
    }

    #[test]
    fn says_nothing_when_there_is_no_percentage() {
        assert_eq!(percent_of("Cloning into /work/demo"), None);
        assert_eq!(percent_of(""), None);
        assert_eq!(percent_of("50 percent"), None);
    }

    #[test]
    fn percent_of_survives_a_multibyte_char_before_the_number() {
        // B3, found by fuzzing: `percent_of` runs on every PTY line during a clone, and lore
        // echoes paths. A repository or folder with an accented character — `Café/`, an `é`
        // in a filename — produced a line where the byte index of the char before the digits
        // landed inside a multibyte sequence. `head[start..]` then panicked with "byte index
        // is not a char boundary", killing the clone reader thread and hanging the clone with
        // the button stuck on "Cloning…". Same failure shape as the ConPTY hang, from data.
        assert_eq!(percent_of("é50%"), Some(50.0));
        assert_eq!(percent_of("Café 73.5%"), Some(73.5));
        assert_eq!(percent_of("progreß 100%"), Some(100.0));
        // A bare multibyte with no number is a clean None, not a crash.
        assert_eq!(percent_of("é%"), None);
        assert_eq!(percent_of("→%"), None);
    }
}

#[cfg(test)]
mod frame_tests {
    use super::{parse_frame, parse_size};

    /// The exact line a real clone draws, pasted from a terminal.
    const REAL: &str = "[█████████████       ] 536/818+  128.92 MiB/1.85 GiB";

    #[test]
    fn reads_the_bar_a_real_clone_draws() {
        let f = parse_frame(REAL).expect("that is a progress frame");
        assert_eq!(f.files_done, 536);
        assert_eq!(f.files_total, 818);
        assert!(f.files_growing, "the + means lore is still counting files");
        assert_eq!(f.bytes_done, (128.92 * 1024.0 * 1024.0) as u64);
        assert_eq!(f.bytes_total, (1.85 * 1024.0 * 1024.0 * 1024.0) as u64);
    }

    #[test]
    fn the_percentage_comes_from_bytes_not_files() {
        // The file total carries a `+` — it is a floor while lore is still discovering files,
        // so a percentage built on it would run backwards as the denominator grew.
        let f = parse_frame(REAL).unwrap();
        let percent = f.percent().unwrap();
        assert!((percent - 6.8).abs() < 0.5, "got {percent}");
        assert!(percent < (f.files_done as f32 / f.files_total as f32) * 100.0);
    }

    #[test]
    fn survives_the_escape_codes_a_terminal_adds() {
        let coloured = "\u{1b}[32m[███   ]\u{1b}[0m 10/20  1.00 MiB/2.00 MiB";
        let f = parse_frame(coloured).expect("colour must not defeat it");
        assert_eq!(f.files_done, 10);
        assert_eq!(f.percent(), Some(50.0));
    }

    #[test]
    fn a_settled_total_has_no_plus() {
        let f = parse_frame("[████] 818/818  1.85 GiB/1.85 GiB").unwrap();
        assert!(!f.files_growing);
        assert_eq!(f.percent(), Some(100.0));
    }

    #[test]
    fn the_header_lines_are_not_frames() {
        // These arrive on the same stream and contain both slashes and sizes. Reading one as
        // a frame would show a percentage built from a revision hash.
        assert!(parse_frame("Cloning repository 019f9e branch main into /work/demo").is_none());
        assert!(parse_frame("Pull state 60a4d537a3f5eb587481c69a4c3b74b8").is_none());
        assert!(parse_frame("Clone complete in 99.95s").is_none());
        assert!(parse_frame("").is_none());
    }

    #[test]
    fn sizes_are_read_in_the_units_lore_prints() {
        assert_eq!(parse_size("512 B"), Some(512));
        assert_eq!(parse_size("1.00 KiB"), Some(1024));
        assert_eq!(parse_size("2.00 GiB"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_size("nonsense"), None);
        assert_eq!(parse_size("12 parsecs"), None);
    }
}

#[cfg(test)]
mod summary_tests {
    use super::{parse_duration, parse_summary};

    #[test]
    fn reads_the_closing_lines_a_real_clone_prints() {
        // Captured from a 2 GiB clone against ctone.
        let (files, bytes) = parse_summary("Cloned 2157/2157 files (2.00 GiB/2.00 GiB)").unwrap();
        assert_eq!(files, 2157);
        assert_eq!(bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(parse_duration("Clone complete in 99.95s"), Some(99.95));
    }

    #[test]
    fn survives_the_terminal_control_codes_that_come_with_it() {
        // Pasted from a real run. The clone erases the progress line as it prints, so the
        // summary arrives wearing an erase-to-end-of-line and the closing lines carry
        // erase-whole-line codes. Stripping those is the difference between reading the
        // clone's own totals and reporting zeroes.
        let (files, bytes) =
            parse_summary("Cloned 2157/2157 files (2.00 GiB/2.00 GiB)\u{1b}[K").unwrap();
        assert_eq!(files, 2157);
        assert_eq!(bytes, 2 * 1024 * 1024 * 1024);

        assert_eq!(parse_duration("Clone complete in 141.37s\u{1b}[2K"), Some(141.37));
        assert_eq!(parse_duration("\u{1b}[2KClone complete in 99.95s"), Some(99.95));
    }

    #[test]
    fn the_spinner_frames_are_not_a_summary() {
        // `⠸ Cloning ...` arrives between the real lines and must not be read as one.
        assert!(parse_summary("⠸ Cloning ...\u{1b}[2K").is_none());
        assert!(parse_duration("⠸ Cloning ...").is_none());
    }

    #[test]
    fn ignores_lines_that_are_not_the_summary() {
        // The progress frames contain the same numbers in a different shape; reading one as
        // the summary would report a total that was only the current position.
        assert!(parse_summary("[███] 536/818+  128.92 MiB/1.85 GiB").is_none());
        assert!(parse_summary("Cloning repository 019f9e branch main into /work").is_none());
        assert!(parse_duration("Cloned 2157/2157 files (2.00 GiB/2.00 GiB)").is_none());
    }

    #[test]
    fn a_growing_file_count_still_yields_a_total() {
        let (files, _) = parse_summary("Cloned 800/818+ files (1.00 GiB/2.00 GiB)").unwrap();
        assert_eq!(files, 818);
    }
}

#[cfg(test)]
mod binary_lookup_tests {
    use super::{lore_in_dir, LORE_EXE};

    /// Clone resolves `lore` by hand — it cannot use the shell plugin, which is the only
    /// thing that knows to add `.exe`. So this is the one lookup that has to carry the
    /// platform's own name, and getting it wrong broke *only* clone on Windows: the host
    /// went green, every other command worked, and Clone reported the binary missing while
    /// it sat right beside the app.
    #[test]
    fn lore_is_found_under_the_name_this_platform_gives_it() {
        let dir = tempfile::tempdir().unwrap();
        // Spelled out rather than reusing LORE_EXE: writing and reading through the same
        // constant is true however wrong that constant is, which is how the first version
        // of this test passed against the bug it was written to catch. This is the name
        // fetch-deps.sh stages and Tauri copies beside the app.
        let staged = if cfg!(windows) { "lore.exe" } else { "lore" };
        std::fs::write(dir.path().join(staged), b"#!/bin/sh\n").unwrap();
        assert_eq!(lore_in_dir(dir.path()), Some(dir.path().join(staged)));
    }

    #[test]
    fn the_name_carries_an_exe_suffix_only_on_windows() {
        // Pinning the fix itself: on Windows the bare Unix name is not what is on disk, and
        // looking for it is what produced "could not be found next to the app".
        if cfg!(windows) {
            assert_eq!(LORE_EXE, "lore.exe");
        } else {
            assert_eq!(LORE_EXE, "lore");
        }
    }

    #[test]
    fn a_directory_without_lore_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(lore_in_dir(dir.path()), None);
    }

    #[test]
    fn a_directory_holding_only_the_other_platforms_name_is_not_a_match() {
        // The regression in both directions: a Windows build must not accept a bare `lore`,
        // and a Unix build must not accept `lore.exe`.
        let dir = tempfile::tempdir().unwrap();
        let wrong = if cfg!(windows) { "lore" } else { "lore.exe" };
        std::fs::write(dir.path().join(wrong), b"x").unwrap();
        assert_eq!(lore_in_dir(dir.path()), None);
    }
}

#[cfg(test)]
mod pty_tests {
    use super::{pump_pty, PtyLine};
    use std::time::Duration;

    /// A pseudo-terminal must report that it has *finished*, not merely deliver output.
    ///
    /// This is the regression test for the bug that got past every other check: the clone
    /// itself worked perfectly — 6/6 files, every line parsed and displayed, "Clone complete
    /// in 0.08s" printed — and the app sat on "Cloning…" forever, because the read never
    /// ended. Reading to EOF is enough on Unix, where the last slave descriptor closing ends
    /// the stream; ConPTY keeps the master open after the child exits, so the loop blocked,
    /// the sender was never dropped, and the `done` event was never emitted.
    ///
    /// Asserted with a deadline rather than by calling it directly, because the failure mode
    /// is a *hang*: without the fix this does not return a wrong answer, it never returns,
    /// and a test that hangs reports nothing useful.
    fn run_with_deadline(args: Vec<String>) -> Option<(i32, Vec<String>)> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PtyLine>();
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        let exe: std::path::PathBuf = if cfg!(windows) { "cmd.exe".into() } else { "/bin/sh".into() };
        std::thread::spawn(move || {
            let r = pump_pty(exe, &args, std::env::temp_dir(), tx);
            let _ = done_tx.send(r);
        });

        let code = done_rx.recv_timeout(Duration::from_secs(20)).ok()?.ok()?;

        let mut lines = Vec::new();
        while let Ok(PtyLine(l)) = rx.try_recv() {
            lines.push(l);
        }
        Some((code, lines))
    }

    fn echo_args(text: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["/c".into(), format!("echo {text}")]
        } else {
            vec!["-c".into(), format!("echo {text}")]
        }
    }

    #[test]
    fn a_finished_command_ends_the_pump_rather_than_blocking_forever() {
        let (code, lines) = run_with_deadline(echo_args("marker-one"))
            .expect("pump_pty did not return: the pseudo-terminal never reported completion");
        assert_eq!(code, 0);
        assert!(
            lines.iter().any(|l| l.contains("marker-one")),
            "expected the command's output to be forwarded, got {lines:?}"
        );
    }

    #[test]
    fn a_failing_command_still_ends_and_reports_its_exit_code() {
        // The error path has to terminate too — a clone that fails must reach the `done`
        // emit, or a failure is displayed as an unending clone.
        let args: Vec<String> = if cfg!(windows) {
            vec!["/c".into(), "exit 3".into()]
        } else {
            vec!["-c".into(), "exit 3".into()]
        };
        let (code, _) = run_with_deadline(args)
            .expect("pump_pty did not return for a failing command");
        assert_eq!(code, 3);
    }

    // --- cleaning up a failed clone (B5) --------------------------------------

    use super::clean_up_partial;
    use std::fs;

    /// A directory that looks like an interrupted clone: a .lore plus some downloaded content.
    fn partial_clone(root: &std::path::Path) {
        fs::create_dir_all(root.join(".lore")).unwrap();
        fs::write(root.join(".lore/config.toml"), "remote_url = \"grpc://h:1\"").unwrap();
        fs::create_dir_all(root.join("art")).unwrap();
        fs::write(root.join("art/asset.bin"), vec![0u8; 1024]).unwrap();
    }

    #[test]
    fn a_folder_the_clone_created_is_removed_whole() {
        // The common case: the user typed a new folder name, the clone made it, the network
        // dropped. The whole directory is ours and goes.
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("new-clone");
        partial_clone(&dest);

        assert!(clean_up_partial(&dest, false), "should report it removed something");
        assert!(!dest.exists(), "a folder we created must be gone entirely");
    }

    #[test]
    fn an_empty_folder_the_user_made_is_emptied_but_kept() {
        // The user made an empty folder and pointed the clone at it. We must not delete the
        // folder itself — its name and place are the user's — only what we wrote into it.
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("my-folder");
        fs::create_dir(&dest).unwrap();
        partial_clone(&dest);

        assert!(clean_up_partial(&dest, true), "should report it removed something");
        assert!(dest.exists(), "the user's folder must remain");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "but it must be empty again");
    }

    #[test]
    fn a_directory_without_a_dot_lore_is_never_touched() {
        // The safety refusal: no .lore means lore failed before writing anything of ours, so
        // there is nothing to clean and we must not act on a state we do not recognise. This
        // is what stops a mistyped dest, or a user directory that merely failed our own guard,
        // from being deleted.
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("not-a-clone");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("important.txt"), "the user's file").unwrap();

        assert!(!clean_up_partial(&dest, false), "no .lore -> nothing removed");
        assert!(dest.join("important.txt").exists(), "the user's file must survive");
    }

    #[test]
    fn ansi_escapes_do_not_leak_into_the_error_lines() {
        // B6, reported from the live B5 test: the clone error showed
        //   Failed to clone file .../blob-500mb.bin\u{1b}[0m
        // with a stray \u{1b}[2K on its own line. The error tail is raw PTY output; it must be
        // run through without_ansi like every other line the terminal produces.
        let raw = "Failed to clone file /work/blob.bin\u{1b}[0m";
        assert_eq!(super::without_ansi(raw), "Failed to clone file /work/blob.bin");
        // An erase-line escape leaves nothing once stripped, so it must not become a blank line.
        assert_eq!(super::without_ansi("\u{1b}[2K").trim(), "");
    }

    #[test]
    fn a_missing_destination_is_a_no_op_not_a_panic() {
        // A clone that failed before creating anything: nothing on disk, nothing to do.
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("never-created");
        assert!(!clean_up_partial(&dest, false));
    }
}
