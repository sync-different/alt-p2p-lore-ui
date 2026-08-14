pub mod lore;
pub mod tunnel;
mod prereq;
pub mod session;
pub mod registry;
pub mod workspace;
pub mod orphans;

use registry::Registry;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Registered for the Rust side only. It is deliberately absent from
        // capabilities/default.json, so the webview cannot spawn anything: argv is built
        // in the backend, where user input never becomes a command line by accident.
        .plugin(tauri_plugin_shell::init())
        .manage(Registry::default())
        .setup(|app| {
            // Before anything else: clear out tunnels a previous run left behind. They hold
            // the local ports this run needs and squat the same coordinator sessions, so
            // starting up beside them produces failures that look like network problems.
            if let Ok(dir) = session::app_dir() {
                let n = orphans::reap(&orphans::pid_file(&dir));
                if n > 0 {
                    eprintln!("cleared {n} tunnel(s) left over from a previous run");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prereq::check_prerequisites,
            registry::list_tunnels,
            lore::repo::is_lore_repo,
            lore::repo::open_repo,
            lore::repo::repo_status,
            lore::repo::file_diff,
            lore::repo::list_dir,
            lore::content::read_file,
            lore::repo::list_locks,
            lore::repo::list_repositories,
            lore::repo::stage_paths,
            lore::repo::unstage_paths,
            lore::repo::commit,
            lore::repo::reset_paths,
            lore::repo::sync,
            lore::repo::push,
            lore::repo::resolve_conflicts,
            lore::repo::abort_merge,
            lore::repo::check_switch_branch,
            lore::repo::switch_branch,
            lore::repo::create_branch,
            lore::clone::clone_repo,
            lore::auth::auth_status,
            lore::auth::auth_login,
            lore::auth::auth_login_token,
            lore::auth::auth_logout,
            lore::auth::auth_refresh_access,
            tunnel::supervisor::start_tunnel,
            tunnel::supervisor::stop_tunnel,
            session::load_sessions,
            session::save_session,
            session::delete_session,
            session::has_psk,
            session::set_psk,
            session::connect_session,
            workspace::load_workspaces,
            workspace::add_workspace,
            workspace::remove_workspace,
            workspace::rename_workspace,
            workspace::set_workspace_identity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Kill every child before the process goes away. Without this, quitting the
            // app leaves tunnels running with no window left to stop them from — and the
            // user has no reason to suspect it, because the app appears closed.
            // Both events, because they do not both fire on every route out of the app —
            // and an orphaned tunnel keeps a port and a coordinator session for as long as
            // it lives. `kill_all` is idempotent, so handling both costs nothing.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                let killed = app.state::<Registry>().kill_all();
                if killed > 0 {
                    eprintln!("stopped {killed} running tunnel(s) on exit");
                }
                if let Ok(dir) = session::app_dir() {
                    let _ = std::fs::remove_file(orphans::pid_file(&dir));
                }
            }
        });
}
