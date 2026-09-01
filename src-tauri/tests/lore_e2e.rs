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
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
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
    let port = free_port();
    let dir = std::env::temp_dir().join(format!("lore-e2e-{}-{}", std::process::id(), port));
    std::fs::create_dir_all(dir.join("cfg")).ok()?;
    std::fs::create_dir_all(dir.join("store")).ok()?;
    // Explicit store paths keep this instance isolated from any other server sharing the default
    // location; an ephemeral grpc/quic port lets tests run in parallel without colliding.
    let cfg = format!(
        "[immutable_store.local]\npath = \"{d}/store/immut\"\n\
         [mutable_store.local]\npath = \"{d}/store/mut\"\n\
         [server.grpc]\nport = {p}\n\
         [server.http]\nport = {h}\n\
         [server.quic]\nport = {p}\n",
        d = dir.display(),
        p = port,
        h = port.wrapping_add(2),
    );
    std::fs::write(dir.join("cfg/local.toml"), cfg).ok()?;
    let child = Command::new(loreserver)
        .arg("--config")
        .arg(dir.join("cfg"))
        .env("LORE_ENV", "local")
        .current_dir(&dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let server = Server { child, port, dir };
    wait_port(port, 20).then_some(server)
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
    /// `Some` when the binaries exist and the server came up; `None` (with a printed reason) when
    /// the environment can't run these — the caller returns early so the test counts as passed.
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
        let server = match start_server(&loreserver) {
            Some(s) => s,
            None => {
                eprintln!("SKIP lore_e2e: scratch loreserver did not start");
                return None;
            }
        };
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
