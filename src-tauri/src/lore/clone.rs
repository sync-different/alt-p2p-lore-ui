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
    let start = head
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
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

fn emit(app: &AppHandle, p: CloneProgress) {
    let _ = app.emit(CLONE_EVENT, p);
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
        for a in &args_for_thread {
            cmd.arg(a);
        }
        cmd.cwd(cwd_for_thread);
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

        let status = child.wait().map_err(|e| format!("The clone could not be waited on ({e})."))?;
        Ok(status.exit_code() as i32)
    });

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
                    percent: frame.percent(),
                    bytes: Some(frame.bytes_done),
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

    let code = worker
        .await
        .map_err(|e| format!("The clone task failed ({e})."))??;

    // The clone's own totals, from the lines it prints last.
    let summary = tail.iter().rev().find_map(|l| parse_summary(l));
    let seconds = tail.iter().rev().find_map(|l| parse_duration(l));

    let ok = code == 0;
    let error = (!ok).then(|| {
        let why = tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join("\n");
        if why.is_empty() {
            format!("The clone stopped unexpectedly (exit code {code}).")
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
            seconds: None,
                        done: Some(ok),
            error: error.clone(),
        },
    );
    match error {
        None => Ok(dest),
        Some(e) => Err(e),
    }
}

/// One piece of terminal output, split on a newline *or* a carriage return.
struct PtyLine(String);

/// The bundled `lore`, or whatever is on PATH in development.
///
/// The sidecar sits next to the app's own executable; resolving it by hand rather than through
/// the shell plugin because that plugin does not offer a terminal, which is the entire reason
/// this path exists.
fn lore_binary(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("lore");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let _ = app;
    // Development: `cargo tauri dev` does not stage sidecars beside the binary.
    which_on_path("lore").ok_or_else(|| {
        "The bundled Lore program could not be found next to the app.".to_string()
    })
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
