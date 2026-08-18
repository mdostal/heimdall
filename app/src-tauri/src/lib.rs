mod sidecar;
mod tray;
mod updater;

use std::process::Child;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Holds the spawned sidecar so it isn't silently orphaned by a dropped
/// handle -- Quit (any path: tray menu, Cmd+Q, Dock) kills it explicitly
/// via the RunEvent handler below. Confirmed live (not assumed) that Cmd+Q
/// on this platform/build configuration delivers RunEvent::Exit directly,
/// WITHOUT a preceding ExitRequested -- kill_sidecar() is idempotent
/// (guards on `guard.take()`), so both events call it and whichever fires
/// first wins.
pub struct SidecarState {
    pub child: Mutex<Option<Child>>,
    pub port: u16,
}

fn kill_sidecar(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        log::warn!("kill_sidecar: no SidecarState found on app handle");
        return;
    };
    let Ok(mut guard) = state.child.lock() else {
        log::error!("kill_sidecar: failed to lock sidecar state mutex");
        return;
    };
    let Some(mut child) = guard.take() else {
        return; // already killed by the other RunEvent variant
    };
    if let Err(e) = child.kill() {
        log::error!("kill_sidecar: kill() failed for pid={}: {e}", child.id());
    }
    let _ = child.wait();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Must be registered first (documented Tauri requirement) -- a
        // second launch focuses the existing window instead of spawning a
        // second sidecar and colliding on the port/DB file.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = sidecar::spawn_sidecar(app.handle());
            let port = handle.port;
            app.manage(SidecarState {
                child: Mutex::new(Some(handle.child)),
                port,
            });

            tray::build_tray(app.handle())?;
            updater::spawn_background_checker(app.handle().clone());

            // Show the loading placeholder immediately; swap to the real
            // sidecar URL (or show an error state) once health-checked --
            // never a browser connection-refused page.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Heimdall")
                .inner_size(1280.0, 860.0)
                .visible(true)
                .build()?;

            // Close-to-tray: the window hides, the sidecar keeps running,
            // the tray icon stays -- standard menu-bar-app UX. Only the
            // explicit Quit path (tray menu / Cmd+Q / Dock) actually
            // terminates, handled once in RunEvent::ExitRequested below.
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_for_close.hide();
                }
            });

            let window_for_thread = window.clone();
            let app_handle_for_thread = app.handle().clone();
            std::thread::spawn(move || {
                if sidecar::wait_until_healthy(port) {
                    let url = format!("http://127.0.0.1:{port}");
                    if let Ok(parsed) = tauri::Url::parse(&url) {
                        let _ = window_for_thread.navigate(parsed);
                    }
                    apply_icon_preference(&app_handle_for_thread, port);
                } else {
                    let _ = window_for_thread.eval(
                        "document.getElementById('spinner').style.display='none';\
                         document.getElementById('status').style.display='none';\
                         var e=document.getElementById('err');\
                         e.style.display='block';\
                         e.textContent='Heimdall did not start in time. \
                         Check that node is installed and on PATH, then relaunch.';",
                    );
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    builder.run(|app_handle, event| {
        // The one place sidecar cleanup is guaranteed to run, regardless
        // of which quit path triggered it (tray "Quit", Cmd+Q, Dock menu,
        // or app.exit() from tray.rs).
        // Confirmed live (not assumed): on this platform/build configuration,
        // Cmd+Q delivers RunEvent::Exit directly, WITHOUT a preceding
        // ExitRequested -- so cleanup must run on both. kill_sidecar() is
        // idempotent (guards on `guard.take()`), so handling both is safe
        // regardless of which one (or both) actually fires for a given quit
        // path.
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            kill_sidecar(app_handle);
        }
    });
}

/// hdl-desktop-icon-settings: applies the operator's persisted icon
/// preference to the tray icon once the sidecar is healthy (the
/// preference itself lives server-side, in the Node/StateStore settings
/// table -- see hdl-unified-dashboard's design-discussion.md §4 for why).
/// Only the tray icon is touched here -- confirmed via real research (not
/// assumed) that Tauri v2 on macOS has no supported way to swap the Dock
/// icon at runtime; that only takes effect on the next `cargo tauri
/// build`, which is why the Settings panel's own copy says so explicitly
/// rather than implying a full live swap. Every failure path here just
/// logs and returns -- a stale tray icon is never worth crashing over.
fn apply_icon_preference(app: &tauri::AppHandle, port: u16) {
    let Some(icon_name) = sidecar::fetch_icon_preference(port) else {
        log::warn!("apply_icon_preference: could not fetch /desktop-icon, leaving default tray icon");
        return;
    };
    let Some(icon_path) = sidecar::resolve_icon_path(app, &icon_name, "32x32.png") else {
        log::warn!("apply_icon_preference: no bundled icon set found for '{icon_name}'");
        return;
    };
    // tauri::tray::TrayIcon::set_icon takes a tauri::image::Image directly
    // -- no need for the raw tray_icon crate's own Icon type or a
    // TryFrom conversion, despite tray-icon being the crate that actually
    // implements the platform-specific tray behind Tauri's wrapper.
    // Confirmed live (not assumed): fetch -> resolve -> load -> set_icon
    // all succeed, verified via cargo tauri dev's real stdout.
    let image = match tauri::image::Image::from_path(&icon_path) {
        Ok(img) => img,
        Err(e) => {
            log::warn!("apply_icon_preference: failed to load {}: {e}", icon_path.display());
            return;
        }
    };
    let Some(tray) = app.tray_by_id("main") else {
        log::warn!("apply_icon_preference: no tray registered under id 'main'");
        return;
    };
    if let Err(e) = tray.set_icon(Some(image)) {
        log::warn!("apply_icon_preference: set_icon failed: {e}");
    }
}
