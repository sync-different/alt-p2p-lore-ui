//! Reaping tunnels that outlived the app.
//!
//! `Registry::kill_all` on `ExitRequested` is the intended path, and it works when the app
//! is closed the way people close apps. It cannot help when the app dies without asking:
//! a crash, a `kill`, a debugger detaching, a quit that never delivered the event. Observed
//! exactly once and that was enough — a tunnel left running with no window, still holding
//! its local port and still registered on the coordinator under the session id, so the next
//! attempt to connect that session met *itself* and neither side worked.
//!
//! So the pids of live tunnels are written down as they start, and read back at launch.
//! This is a safety net, not the mechanism: if `kill_all` did its job the file names only
//! processes that are already gone.
//!
//! **The pid file is not trusted.** A pid recorded yesterday may belong to something else
//! entirely today — pids are reused, and killing a stranger because a stale file named it
//! would be a far worse bug than the one being fixed. Every candidate is checked against
//! its own command line first, and only a process that is recognisably one of our tunnels
//! is signalled.

use std::io::Write;
use std::path::{Path, PathBuf};

/// What a tunnel's command line must contain to be ours. Both, not either: `java` alone is
/// half the machine and the jar name alone could appear in someone's editor session.
const MARKERS: [&str; 2] = ["alt-p2p-lore.jar", "connect"];

pub fn pid_file(app_data: &Path) -> PathBuf {
    app_data.join("running-tunnels.json")
}

fn read(path: &Path) -> Vec<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<u32>>(&t).ok())
        .unwrap_or_default()
}

fn write(path: &Path, pids: &[u32]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::File::create(path) {
        let _ = f.write_all(serde_json::to_string(pids).unwrap_or_default().as_bytes());
    }
}

/// Note a tunnel we have just started.
pub fn record(path: &Path, pid: u32) {
    let mut pids = read(path);
    if !pids.contains(&pid) {
        pids.push(pid);
        write(path, &pids);
    }
}

/// Forget a tunnel that has stopped.
pub fn forget(path: &Path, pid: u32) {
    let pids: Vec<u32> = read(path).into_iter().filter(|p| *p != pid).collect();
    write(path, &pids);
}

/// The command line of a running process, if it is running.
#[cfg(unix)]
fn command_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(not(unix))]
fn command_of(_pid: u32) -> Option<String> {
    // Windows is not a target yet; without a way to confirm identity, kill nothing.
    None
}

/// Is this pid one of our tunnels, rather than whatever inherited the number?
pub fn looks_like_a_tunnel(command: &str) -> bool {
    MARKERS.iter().all(|m| command.contains(m))
}

#[cfg(unix)]
fn terminate(pid: u32) {
    // SIGTERM: the tunnel closes its sockets and deregisters on the way out, which SIGKILL
    // would deny it. Anything that ignores it is left alone rather than escalated — a
    // process we cannot stop politely is not one to shoot at launch.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) {}

/// Kill tunnels left over from a previous run. Returns how many were signalled.
pub fn reap(path: &Path) -> usize {
    let pids = read(path);
    let mut n = 0;
    for pid in pids {
        match command_of(pid) {
            Some(cmd) if looks_like_a_tunnel(&cmd) => {
                eprintln!("reaping orphaned tunnel pid {pid} from a previous run");
                terminate(pid);
                n += 1;
            }
            Some(_) => {
                // The number was reused. Saying so is worth a line: it is the case where a
                // less careful version of this would have killed a stranger.
                eprintln!("pid {pid} is no longer our tunnel; leaving it alone");
            }
            None => {}
        }
    }
    write(path, &[]);
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_pid_survives_a_round_trip_and_can_be_forgotten() {
        let dir = std::env::temp_dir().join(format!("altlore-orphans-{}", std::process::id()));
        let path = pid_file(&dir);
        let _ = std::fs::remove_file(&path);

        record(&path, 111);
        record(&path, 222);
        record(&path, 111); // recording twice must not duplicate
        assert_eq!(read(&path), vec![111, 222]);

        forget(&path, 111);
        assert_eq!(read(&path), vec![222]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_file_is_simply_empty() {
        // This runs at startup. It must never be the reason the app fails to launch.
        let dir = std::env::temp_dir().join(format!("altlore-orphans-bad-{}", std::process::id()));
        let path = pid_file(&dir);
        assert_eq!(read(&path), Vec::<u32>::new());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not json at all").unwrap();
        assert_eq!(read(&path), Vec::<u32>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_recognisable_tunnel_is_a_candidate() {
        // The guard that stops a reused pid from being killed.
        assert!(looks_like_a_tunnel(
            "/path/jre/bin/java -jar /path/alt-p2p-lore.jar connect --json --local-port 41500"
        ));
        assert!(!looks_like_a_tunnel("/usr/bin/java -jar something-else.jar connect"));
        assert!(!looks_like_a_tunnel("vim alt-p2p-lore.jar.notes"));
        assert!(!looks_like_a_tunnel("/bin/zsh"));
    }

    #[test]
    fn reaping_an_empty_list_does_nothing_and_clears_the_file() {
        let dir = std::env::temp_dir().join(format!("altlore-orphans-empty-{}", std::process::id()));
        let path = pid_file(&dir);
        record(&path, 999_999); // a pid that cannot be running
        assert_eq!(reap(&path), 0);
        assert_eq!(read(&path), Vec::<u32>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
