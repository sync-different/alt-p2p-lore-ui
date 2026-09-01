//! End-to-end tests that drive **real `lore`** against a **scratch `loreserver`**.
//!
//! The unit and golden tests pin parsing against captured text; nothing there exercises the
//! actual clone/commit/push/**conflict-resolve** round-trip. That gap is where the worst bug this
//! app can have lives: a *"Keep my version"* that silently keeps the *host's* line (shipped once,
//! fixed in build 21). These tests reproduce that flow without a human — the exact thing that was
//! being checked by hand at the GUI — so a regression in either the app's mapping
//! (`resolve_side_arg`) or lore's own semantics fails the build.
//!
//! **They skip cleanly when the binaries aren't present**, so `cargo test` stays green on a machine
//! without lore. Provide the binaries via `ALT_LORE_TEST_LORE` / `ALT_LORE_TEST_LORESERVER`, or they
//! are found at `~/.local/bin/{lore,loreserver}`. Run just these with:
//!     cargo test --test lore_e2e -- --nocapture

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use alt_p2p_lore_ui_lib::lore::repo::resolve_side_arg;

/// These tests each run their own scratch server, and starting several at once races on port
/// selection (bind-to-0 then release) and on machine resources. Serialize them with a global lock
/// held for the whole harness lifetime — poison-tolerant so one panicking test doesn't wedge the
/// rest. Held until the harness (and thus its server) is dropped.
fn test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

// ---- binary discovery (skip-friendly) ----------------------------------------------------------

fn find_bin(env_key: &str, name: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_key) {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let home = std::env::var("HOME").ok()?;
    let pb = PathBuf::from(home).join(".local/bin").join(name);
    pb.exists().then_some(pb)
}

// ---- scratch loreserver lifecycle --------------------------------------------------------------

/// A scratch `loreserver` with an isolated store on an ephemeral port. Killed and its temp dir
/// removed on drop, so a panicking test never leaks a process or leaves data behind.
struct Server {
    child: Child,
    port: u16,
    dir: PathBuf,
    bin: PathBuf,
}

impl Server {
    /// Hard-crash the server (`SIGKILL`) and bring it straight back up on the same store and port —
    /// the `kill -9` a crash or `systemctl kill -s KILL` would do. Used to prove the store stays
    /// consistent across a crash in the write path (loreserver's durability fix).
    fn kill_and_restart(&mut self) -> bool {
        let _ = self.child.kill();
        let _ = self.child.wait();
        match spawn_loreserver(&self.bin, &self.dir) {
            Some(child) => {
                self.child = child;
                wait_port(self.port, 20)
            }
            None => false,
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Spawn `loreserver` against the config already written under `dir/cfg`. Shared by first start and
/// restart so both go through exactly one code path.
fn spawn_loreserver(bin: &Path, dir: &Path) -> Option<Child> {
    // Capture BOTH stdout and stderr to one log file (#131). loreserver logs some fatal errors to
    // stdout (the port-in-use error) and others to stderr (a bad config), so capturing only one leaves
    // the log empty in exactly the case it exists to explain. Two handles to the same file merge them.
    let log = std::fs::File::create(dir.join("loreserver.log")).ok();
    let (out, err) = match log.as_ref().and_then(|f| f.try_clone().ok()) {
        Some(clone) => (Stdio::from(log.unwrap()), Stdio::from(clone)),
        None => (Stdio::null(), Stdio::null()),
    };
    Command::new(bin)
        .arg("--config")
        .arg(dir.join("cfg"))
        .env("LORE_ENV", "local")
        .current_dir(dir)
        .stdout(out)
        .stderr(err)
        .spawn()
        .ok()
}

/// Two distinct free ports, both actually reserved.
///
/// The gRPC port used to be the only one asked for, and the HTTP port was derived as
/// `port + 2` - a number nothing had checked. Windows hands out ephemeral ports in
/// near-sequential runs, so `port + 2` was frequently already held (often by the previous
/// test's server or its TIME_WAIT), and loreserver died at startup with
///
///     Failed to start HTTP server: Only one usage of each socket address ... (os error 10048)
///
/// which is WSAEADDRINUSE. That surfaced as the intermittent "scratch loreserver did not
/// start", and was invisible because loreserver logs this to STDOUT, which the harness discards.
///
/// Both listeners are held open at once and dropped together, so the two ports cannot collide
/// with each other the way two sequential `free_port()` calls could.
fn two_free_ports() -> (u16, u16) {
    let a = TcpListener::bind("127.0.0.1:0").unwrap();
    let b = TcpListener::bind("127.0.0.1:0").unwrap();
    let pa = a.local_addr().unwrap().port();
    let pb = b.local_addr().unwrap().port();
    (pa, pb)
}

fn wait_port(port: u16, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn start_server(loreserver: &Path) -> Option<Server> {
    let (port, http_port) = two_free_ports();
    let dir = std::env::temp_dir().join(format!("lore-e2e-{}-{}", std::process::id(), port));
    std::fs::create_dir_all(dir.join("cfg")).ok()?;
    std::fs::create_dir_all(dir.join("store")).ok()?;
    // Explicit store paths keep this instance isolated from any other server sharing the default
    // location; an ephemeral grpc/quic port lets tests run in parallel without colliding.
    // A short flush delay lets the durability test make a write durable in ~1s instead of the 10s
    // default, so it can crash *after* something has landed and check the store stays consistent.
    let cfg = format!(
        "[immutable_store.local]\npath = \"{d}/store/immut\"\nflush_delay_seconds = 1\n\
         [mutable_store.local]\npath = \"{d}/store/mut\"\nflush_delay_seconds = 1\n\
         [server.grpc]\nport = {p}\n\
         [server.http]\nport = {h}\n\
         [server.quic]\nport = {p}\n",
        // Forward slashes, always. `dir.display()` on Windows yields `C:\Users\...`, and that is
        // interpolated into a TOML **basic** string, where a backslash opens an escape: `\U`
        // means `\UXXXXXXXX`, so `\Users` is a parse error and loreserver exits before it ever
        // listens. The harness then prints only "scratch loreserver did not start" and all five
        // tests SKIP while counting as passed - the exact false green this file warns about, but
        // from a different cause than the env vars. Windows accepts forward slashes in paths, so
        // this is the smallest change that is correct on both platforms.
        d = dir.display().to_string().replace('\\', "/"),
        p = port,
        h = http_port,
    );
    std::fs::write(dir.join("cfg/local.toml"), cfg).ok()?;
    let child = spawn_loreserver(loreserver, &dir)?;
    let server = Server {
        child,
        port,
        dir,
        bin: loreserver.to_path_buf(),
    };
    if wait_port(port, 20) {
        Some(server)
    } else {
        // The binary exists but never listened — a REAL failure. Print its stderr so the cause is
        // visible (read before `server` drops and removes the temp dir), then return None; the
        // caller turns this into a panic, not a silent skip (#131).
        let log = std::fs::read_to_string(server.dir.join("loreserver.log")).unwrap_or_default();
        eprintln!(
            "lore_e2e: scratch loreserver did not start on port {port}.\n\
             --- loreserver output (stdout+stderr) ---\n{}\n-------------------------",
            log.trim()
        );
        None
    }
}

// ---- harness ----------------------------------------------------------------------------------

struct Harness {
    lore: PathBuf,
    server: Server,
    work: PathBuf,
    // Declared last so it is dropped last: the lock is released only after `server` has been
    // killed and its temp dir removed, so the next test never starts while this one is tearing down.
    _guard: MutexGuard<'static, ()>,
}

impl Harness {
    /// `Some` when the binaries exist and the server came up. `None` ONLY when a binary is absent —
    /// a legitimate environment skip, and the caller returns early (test counts as passed). If the
    /// binaries ARE present but the scratch server fails to start, that is a real bug, so we panic
    /// (fail the test) rather than skip — otherwise a broken server reads as "5 passed" (#131).
    fn start() -> Option<Harness> {
        let guard = test_lock();
        let lore = match find_bin("ALT_LORE_TEST_LORE", "lore") {
            Some(p) => p,
            None => {
                eprintln!("SKIP lore_e2e: `lore` not found (set ALT_LORE_TEST_LORE or install to ~/.local/bin)");
                return None;
            }
        };
        let loreserver = match find_bin("ALT_LORE_TEST_LORESERVER", "loreserver") {
            Some(p) => p,
            None => {
                eprintln!("SKIP lore_e2e: `loreserver` not found (set ALT_LORE_TEST_LORESERVER or install to ~/.local/bin)");
                return None;
            }
        };
        // Binaries are present, so the scratch server MUST start — a failure here is a real bug, not
        // a skip. Panic (fail the test) with the cause printed above, instead of silently passing.
        let server = start_server(&loreserver).unwrap_or_else(|| panic!(
            "lore_e2e: loreserver was found but the scratch server failed to start — a real failure, \
             not a skippable environment gap (its stderr is printed above)."));
        let work = server.dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        Some(Harness {
            lore,
            server,
            work,
            _guard: guard,
        })
    }

    fn url(&self, repo: &str) -> String {
        format!("grpc://127.0.0.1:{}/{}", self.server.port, repo)
    }

    /// Run `lore` in `cwd`; returns (success, combined stdout+stderr). Never panics on a non-zero
    /// exit (callers decide, since a *diverged* push is expected to fail).
    fn run(&self, cwd: &Path, args: &[&str]) -> (bool, String) {
        let out = Command::new(&self.lore)
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn lore");
        let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
        s.push_str(&String::from_utf8_lossy(&out.stderr));
        (out.status.success(), s)
    }

    /// Assert a `lore` invocation succeeded, surfacing its output on failure.
    fn ok(&self, cwd: &Path, args: &[&str]) -> String {
        let (ok, out) = self.run(cwd, args);
        assert!(ok, "lore {:?} failed:\n{}", args, out);
        out
    }

    fn commit_all(&self, wc: &Path, msg: &str) {
        self.ok(wc, &["stage", ".", "--scan"]);
        self.ok(wc, &["commit", msg]);
    }

    /// Create a repo, seed one file, push; return the working-copy path.
    fn seed_repo(&self, repo: &str, file: &str, contents: &str) -> PathBuf {
        let wc = self.work.join(format!("{repo}-seed"));
        std::fs::create_dir_all(&wc).unwrap();
        self.ok(&wc, &["repository", "create", &self.url(repo)]);
        std::fs::write(wc.join(file), contents).unwrap();
        self.commit_all(&wc, "seed");
        self.ok(&wc, &["push"]);
        wc
    }

    fn clone(&self, repo: &str, name: &str) -> PathBuf {
        let dst = self.work.join(name);
        self.ok(&self.work, &["clone", &self.url(repo), dst.to_str().unwrap()]);
        dst
    }

    /// The heart of it: build a same-line conflict between two clones, then resolve it with the
    /// argument the **app** would pass for `keep_user` (`resolve_side_arg`). Returns the surviving
    /// second line so the caller can assert whose edit won.
    fn conflict_survivor(&self, repo: &str, keep_user: bool) -> String {
        let probe = "probe.txt";
        let a = self.seed_repo(repo, probe, "line1\nORIGINAL\nline3\n");
        let b = self.clone(repo, &format!("{repo}-B"));

        // host advances
        std::fs::write(a.join(probe), "line1\nHOST\nline3\n").unwrap();
        self.commit_all(&a, "host edit");
        self.ok(&a, &["push"]);

        // user edits the same line locally
        std::fs::write(b.join(probe), "line1\nUSER\nline3\n").unwrap();
        self.commit_all(&b, "user edit");

        // push is refused (diverged); sync produces the conflict
        let (pushed, _) = self.run(&b, &["push"]);
        assert!(!pushed, "expected the divergent push to be refused");
        self.ok(&b, &["sync"]);

        // resolve using the app's own mapping, then read the survivor
        let arg = resolve_side_arg(keep_user);
        self.ok(&b, &["branch", "merge", "resolve", arg, probe]);
        std::fs::read_to_string(b.join(probe))
            .unwrap()
            .lines()
            .nth(1)
            .unwrap_or("")
            .to_string()
    }
}

// ---- tests ------------------------------------------------------------------------------------

/// The flagship: *Keep my version* must preserve the user's local line, and the other side must
/// take the host's — verified against real lore, through the app's own `resolve_side_arg`. A flip
/// in either the mapping or lore's semantics fails here instead of silently losing a user's work.
#[test]
fn keep_my_version_preserves_the_users_line() {
    let Some(h) = Harness::start() else { return };
    assert_eq!(
        h.conflict_survivor("keepuser", true),
        "USER",
        "keep_user=true (resolve_side_arg->theirs) must keep the user's local line"
    );
    assert_eq!(
        h.conflict_survivor("takehost", false),
        "HOST",
        "keep_user=false (resolve_side_arg->mine) must take the host's incoming line"
    );
}

/// A pushed revision comes back byte-identical on a fresh clone.
#[test]
fn push_then_clone_is_byte_identical() {
    let Some(h) = Harness::start() else { return };
    let contents = "alpha\nbeta\ngamma\n";
    h.seed_repo("roundtrip", "data.txt", contents);
    let c = h.clone("roundtrip", "roundtrip-verify");
    assert_eq!(
        std::fs::read(c.join("data.txt")).unwrap(),
        contents.as_bytes(),
        "clone content must match what was pushed, byte for byte"
    );
}

/// `lore branch create` switches the working copy onto the new branch (the app reports what lore
/// does, so this pins the behaviour the UI depends on).
#[test]
fn branch_create_switches_working_copy() {
    let Some(h) = Harness::start() else { return };
    let wc = h.seed_repo("branchsw", "f.txt", "one\n");
    assert!(h.ok(&wc, &["status", "--offline"]).contains("On branch main"));
    h.ok(&wc, &["branch", "create", "feature-x"]);
    assert!(
        h.ok(&wc, &["status", "--offline"]).contains("On branch feature-x"),
        "branch create should move the working copy to feature-x"
    );
}

/// An unpushed local merge is *ahead* of the host even though `status` calls it "diverged" and
/// `sync` no-ops — `push` is what publishes it. Pins the stuck-sync case the app works around.
#[test]
fn diverged_local_merge_publishes_via_push() {
    let Some(h) = Harness::start() else { return };
    // reuse the conflict machinery to land B on a resolved-but-unpushed merge
    let survivor = h.conflict_survivor("stucksync", true);
    assert_eq!(survivor, "USER");
    let b = h.work.join("stucksync-B");
    h.commit_all(&b, "merge");
    // status calls it diverged; push nonetheless succeeds and publishes the merge
    let (pushed, out) = h.run(&b, &["push"]);
    assert!(pushed, "push of an ahead local merge should succeed:\n{out}");
    // a fresh clone now carries the user's line
    let v = h.clone("stucksync", "stucksync-verify");
    assert_eq!(
        std::fs::read_to_string(v.join("probe.txt"))
            .unwrap()
            .lines()
            .nth(1)
            .unwrap_or(""),
        "USER",
        "the pushed merge should carry the user's line to the host"
    );
}

/// A hard crash in the write path must leave the repository **consistent and usable**, not wedged.
/// On 0.8.6 a `kill -9` inside the flush window could advance the branch pointer past a revision it
/// then lost, trapping the branch ("failed to load current latest state"); 0.9.0's storage fix keeps
/// the pointer from outrunning durable data. We don't assert the last (possibly unflushed) write
/// survives — flush timing makes that nondeterministic — only that the repo still clones and accepts
/// a fresh push afterwards, which a trapped branch would not. (Found on Fedora during M2.5.)
#[test]
fn kill_9_leaves_the_repository_consistent() {
    let Some(mut h) = Harness::start() else { return };
    let wc = h.seed_repo("durability", "d.txt", "seed\n");
    // Let the seed become durable (flush_delay is 1s here) so the crash below can't simply lose the
    // whole store — the point is consistency of what *did* land, not that nothing is ever lost.
    std::thread::sleep(Duration::from_secs(2));

    // A second write pushed right before the crash — it may or may not have flushed; either way the
    // repo must not end up with its branch pointing at a revision whose data is gone.
    std::fs::write(wc.join("d.txt"), "seed\nsecond\n").unwrap();
    h.commit_all(&wc, "second");
    h.ok(&wc, &["push"]);

    assert!(
        h.server.kill_and_restart(),
        "server must come back up after kill -9"
    );

    // Consistent + usable: a clone succeeds and a follow-up push is accepted. A branch trapped by the
    // old durability hole would reject the push with a "current latest state" error.
    let v = h.clone("durability", "durability-verify");
    std::fs::write(v.join("d.txt"), "post-crash\n").unwrap();
    h.commit_all(&v, "post-crash");
    let (pushed, out) = h.run(&v, &["push"]);
    assert!(
        pushed,
        "after kill -9 the repo must stay usable — a follow-up push should succeed, not hit a trapped branch:\n{out}"
    );
}
