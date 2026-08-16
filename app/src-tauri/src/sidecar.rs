//! Spawns Heimdall's own compiled Node entrypoint (`dist/main.js`) as a
//! plain OS process (no bundled Node runtime -- this app targets one
//! already-provisioned machine, not portable distribution -- adapted from
//! Portunus's real, shipped desktop app, see design-discussion.md §1) and
//! waits for it to answer /healthz before the window is allowed to point at
//! it.
//!
//! Two real risks this module exists to handle explicitly, carried over
//! unchanged from Portunus's own hard-won fixes: a GUI-launched process on
//! macOS gets a near-empty PATH, so `claude`/`gh`/`multica` CLI shell-outs
//! Heimdall itself makes would silently fail to find those binaries unless
//! we capture and forward the *real* login-shell PATH; and a hardcoded port
//! can collide with something else already running, so we always bind a
//! fresh OS-assigned free port.
//!
//! Unlike Portunus's Next.js standalone build, Heimdall has no separate
//! frontend artifact -- its dashboard and docs viewer are served directly by
//! the same Node process this spawns `dist/main.js` as. The bundled resource
//! dir also becomes the process's cwd (so `.env` loading/writing, which
//! Heimdall's own code always resolves relative to cwd, lands in a stable
//! per-user app-data directory instead of wherever the .app happens to be
//! installed) and HEIMDALL_REPO_ROOT (so the docs viewer finds docs/*.md in
//! the bundle, not at cwd).

use std::env;
use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use wait_timeout::ChildExt;

const PATH_CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// A conservative fallback PATH used only if capturing the user's real login
/// shell PATH fails outright (unusual shell config, timeout) -- covers the
/// common install locations for Homebrew's `node` and the `claude`/`gh` CLIs,
/// so the app degrades rather than hanging forever.
fn fallback_path() -> String {
    let home = env::var("HOME").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{home}/.local/bin")
}

/// Runs the user's own login shell non-interactively to capture the *real*
/// PATH (GUI-launched apps on macOS do not source .zshrc/.zprofile, so
/// `std::env::var("PATH")` inside a Tauri app is near-empty -- a confirmed,
/// not hypothetical, gotcha, per Portunus's own research). Bounded by a
/// timeout so a hung/unusual shell config can never block app launch
/// indefinitely.
pub fn capture_login_shell_path() -> String {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = match Command::new(&shell)
        .args(["-ilc", "echo -n \"$PATH\""])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return fallback_path(),
    };

    match child.wait_timeout(PATH_CAPTURE_TIMEOUT) {
        Ok(Some(status)) if status.success() => {
            let mut out = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                let _ = stdout.read_to_string(&mut out);
            }
            let out = out.trim().to_string();
            if out.is_empty() {
                fallback_path()
            } else {
                out
            }
        }
        Ok(Some(_)) => fallback_path(),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            fallback_path()
        }
        Err(_) => fallback_path(),
    }
}

/// Binds port 0 to get a free OS-assigned port, then immediately releases it.
/// A small TOCTOU race exists between release and the sidecar's own bind --
/// acceptable for a single-user local app (same accepted tradeoff Portunus's
/// own sidecar makes).
pub fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind an ephemeral port");
    listener.local_addr().expect("listener has no local addr").port()
}

/// Relative path (from the Heimdall root) to the compiled entrypoint.
/// tsconfig.json sets `rootDir: "."` with `include: ["src/**/*.ts", ...]`,
/// so tsc mirrors `src/` under `dist/` -- the real output is
/// `dist/src/main.js`, NOT `dist/main.js` (confirmed via a real `npm run
/// build`; a stale `dist/main.js` exists from an old tsconfig layout and
/// must not be used).
pub const MAIN_JS_RELATIVE: &str = "dist/src/main.js";

/// Resolves the bundled Heimdall resource root (contains dist/, node_modules/,
/// docs/, package.json -- see build-resources.sh). Prefers the bundled Tauri
/// resource (the real installed-app path); falls back to the live repo
/// checkout for `cargo tauri dev` iteration, where resources aren't copied
/// into a bundle at all.
pub fn resolve_heimdall_root(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("heimdall");
        if bundled.join(MAIN_JS_RELATIVE).exists() {
            return bundled;
        }
    }
    // Dev fallback only -- CARGO_MANIFEST_DIR is app/src-tauri, so ../...
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("..").join("..")
}

/// Per-user app-data directory (`~/Library/Application Support/Heimdall` on
/// macOS) -- becomes the spawned process's cwd, so .env loading/writing and
/// the SQLite DB file land somewhere stable and writable regardless of where
/// the .app bundle itself is installed, and survive an app update (the
/// resource dir gets replaced on update; this directory does not).
pub fn resolve_app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("heimdall-app-data"))
}

pub struct SidecarHandle {
    pub child: Child,
    pub port: u16,
}

/// Spawns `node --experimental-sqlite --env-file-if-exists=.env dist/main.js`
/// with PORT=<port>, the captured real PATH, a persistent HEIMDALL_DB_PATH,
/// and HEIMDALL_REPO_ROOT pointed at the bundled docs/. Does not wait for
/// readiness -- call `wait_until_healthy` separately so the caller can show
/// a loading UI in the meantime.
pub fn spawn_sidecar(app: &AppHandle) -> SidecarHandle {
    let heimdall_root = resolve_heimdall_root(app);
    let main_js = heimdall_root.join(MAIN_JS_RELATIVE);
    let app_data_dir = resolve_app_data_dir(app);
    fs::create_dir_all(&app_data_dir).unwrap_or_else(|e| {
        log::warn!("failed to create app data dir {}: {e}", app_data_dir.display());
    });

    let port = pick_free_port();
    let path = capture_login_shell_path();
    let db_path = app_data_dir.join("heimdall.db");

    let child = Command::new("node")
        .arg("--experimental-sqlite")
        .arg("--env-file-if-exists=.env")
        .arg(&main_js)
        .current_dir(&app_data_dir)
        .env("PORT", port.to_string())
        .env("PATH", path)
        .env("HEIMDALL_DB_PATH", db_path.to_string_lossy().to_string())
        .env("HEIMDALL_REPO_ROOT", heimdall_root.to_string_lossy().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| {
            panic!("failed to spawn sidecar (node {}): {e}", main_js.display())
        });

    SidecarHandle { child, port }
}

/// Polls http://127.0.0.1:<port>/healthz until it returns 200, or gives up
/// after HEALTH_POLL_TIMEOUT. Returns true if the sidecar became healthy.
pub fn wait_until_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let deadline = std::time::Instant::now() + HEALTH_POLL_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = ureq::get(&url).timeout(Duration::from_secs(2)).call() {
            if resp.status() == 200 {
                return true;
            }
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    false
}
