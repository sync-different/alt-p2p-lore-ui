// run-java (Windows) — launches the bundled JRE, or falls back to a system one.
//
// The Unix counterpart is `run-java.sh`. This exists because Windows cannot execute a
// shell script as a Tauri sidecar: the sidecar must be a real PE image, and a `.cmd`
// renamed `.exe` will not load. Compiled by `scripts/fetch-deps.sh` with plain `rustc`
// (no crate, no manifest) — which is why it uses nothing outside `std`.
//
// Keeping a sidecar named `run-java` on both platforms is the point: `supervisor.rs` and
// `prereq.rs` ask for it by name and never learn which OS they are on.
//
// Layout it resolves against. On Windows, unlike macOS, dev and bundle agree — Tauri puts
// resources beside the executable in both, so `.\jre\bin\java.exe` is correct for
// `tauri dev` *and* for an installed app. That makes a bundling mistake visible in dev
// here, where on macOS the `../Resources` hop silently falls through to system Java.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Tie the JVM's lifetime to this wrapper's, so it cannot outlive us.
///
/// Windows does not kill children with their parent. That matters here more than it looks:
/// the pid Tauri hands the registry is *this wrapper's*, and `CommandChild::kill` terminates
/// only that — so every `kill_all` on exit, every Disconnect, and every reaped orphan left a
/// live JVM holding the local loreserver port and its coordinator session. Observed twice in
/// one session: port 41400 held by a JVM whose parent was already gone, with the next connect
/// refused for a port nothing appeared to be using.
///
/// A job object with `KILL_ON_JOB_CLOSE` fixes it at the source rather than at each of the
/// three `child.kill()` sites: the handle is never closed by hand, so the *only* thing that
/// closes it is this process ending — however it ends, including `TerminateProcess` and a
/// crash — and Windows then kills everything in the job. `orphans.rs` remains the safety net
/// for JVMs left by an earlier build, not the mechanism.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    type Handle = *mut core::ffi::c_void;

    // Layout must match Win32 exactly; `repr(C)` gives the same padding on x86_64.
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    }

    /// Deliberately never closed. Closing it is precisely what kills the JVM, so the handle
    /// must live exactly as long as this process and be released only by the OS.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn handle() -> Handle {
        *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if !job.is_null() {
                let mut limits = ExtendedLimits::default();
                limits.basic.limit_flags = KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    EXTENDED_LIMIT_INFORMATION,
                    &mut limits as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                );
            }
            job as usize
        }) as Handle
    }

    /// Best effort by design: if the job cannot be created or assigned, the tunnel should
    /// still start. The cost of failing here is the leak we had before, not a broken app.
    pub fn adopt(child: &std::process::Child) {
        let job = handle();
        if job.is_null() {
            return;
        }
        unsafe {
            AssignProcessToJobObject(job, child.as_raw_handle() as Handle);
        }
    }
}

/// Start the child and wait for it, tying its lifetime to ours where the OS allows.
///
/// Unix needs nothing equivalent: the shell counterpart `exec`s, so there is no wrapper left
/// to outlive. Windows has no `exec`, which is the whole reason a job object is required.
fn run(mut cmd: Command) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(windows)]
    {
        let mut child = cmd.spawn()?;
        // Assigned immediately after spawn. A suspended start would close the theoretical gap
        // between the two, but std gives no way to resume one, and the JVM does nothing worth
        // outliving in the microseconds concerned.
        job::adopt(&child);
        child.wait()
    }
    #[cfg(not(windows))]
    {
        cmd.status()
    }
}

/// Spawn without allocating a console. Without this a GUI-launched app flashes a black
/// window on every tunnel start, because `java.exe` is a console subsystem binary.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Windows bundle and `tauri dev` both put resources beside the executable.
            // Verified against this build: target/release/ holds jre/, lore.exe and the jar
            // alongside run-java.exe, which is the same layout NSIS and MSI install.
            out.push(dir.join("jre").join("bin").join("java.exe"));
            // Tauri has also been observed nesting resources one level down. Taken from
            // alt-p2p-ui's sidecar, which met this layout in a shipped Windows build.
            out.push(dir.join("resources").join("jre").join("bin").join("java.exe"));
            // The macOS bundle relationship, harmless to try and cheap to keep in step.
            out.push(dir.join("..").join("Resources").join("jre").join("bin").join("java.exe"));
        }
    }

    // A developer's own JDK, in the order Windows itself would prefer.
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.is_empty() {
            out.push(PathBuf::from(home).join("bin").join("java.exe"));
        }
    }

    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    for candidate in candidates() {
        if !candidate.is_file() {
            continue;
        }
        let mut cmd = Command::new(&candidate);
        cmd.args(&args)
            // Explicit rather than relying on `status()`'s default: the supervisor parses
            // this child's stdout as NDJSON, so the streams being passed straight through
            // is the contract, not an incidental property of how it is spawned.
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // Windows has no exec(): the launcher stays alive as the parent, so the child's
        // exit code has to be carried out by hand. The supervisor treats a non-zero exit
        // as a failed tunnel, so swallowing it here would report a crash as a clean stop.
        match run(cmd) {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            // Found but unrunnable (a truncated copy, a virus scanner holding it): try the
            // next candidate rather than reporting "no Java" while a JRE sits on disk.
            Err(_) => continue,
        }
    }

    // Last resort: whatever `java` is on PATH. Separate from the list above because it is
    // resolved by name rather than by path, and only Windows' own search can do that.
    let mut cmd = Command::new("java");
    cmd.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(status) = run(cmd) {
        std::process::exit(status.code().unwrap_or(1));
    }

    // Reported as JSON because the caller parses this stream; a bare message would be
    // swallowed as an unparseable line and surface as a generic failure.
    println!(
        "{{\"event\":\"error\",\"message\":\"No Java runtime found. The bundled runtime is missing and no system Java is installed.\"}}"
    );
    std::process::exit(1);
}
