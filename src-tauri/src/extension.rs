//! Browser-extension helpers: copy the bundled extension to a stable folder,
//! open the browser's extensions page and detect whether it is installed.
//!
//! Chrome and Brave do not let other programs install extensions that are not
//! published on the Chrome Web Store (blocked on macOS/Windows since 2014), so
//! the app prepares everything and the user confirms "Load unpacked" once.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Stable ID derived from the `key` in `extension/manifest.json`.
pub const EXTENSION_ID: &str = "kighdmoclfiedbflfcokhjfbogoihdmp";

#[derive(Clone, Copy)]
enum Browser {
    Chrome,
    Brave,
}

impl Browser {
    const ALL: [Browser; 2] = [Browser::Chrome, Browser::Brave];

    fn id(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::Brave => "brave",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Browser::Chrome => "Google Chrome",
            Browser::Brave => "Brave",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|b| b.id() == id)
    }

    fn extensions_url(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome://extensions/",
            Browser::Brave => "brave://extensions/",
        }
    }

    /// Folder that holds the browser profiles (`Default`, `Profile 1`, …).
    fn user_data_dir(self, home: &Path) -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        let rel = match self {
            Browser::Chrome => "Library/Application Support/Google/Chrome",
            Browser::Brave => "Library/Application Support/BraveSoftware/Brave-Browser",
        };
        #[cfg(target_os = "linux")]
        let rel = match self {
            Browser::Chrome => ".config/google-chrome",
            Browser::Brave => ".config/BraveSoftware/Brave-Browser",
        };
        #[cfg(target_os = "windows")]
        {
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            let _ = home;
            Some(match self {
                Browser::Chrome => local.join("Google/Chrome/User Data"),
                Browser::Brave => local.join("BraveSoftware/Brave-Browser/User Data"),
            })
        }
        #[cfg(not(target_os = "windows"))]
        Some(home.join(rel))
    }

    /// Executable / app bundle used to open the extensions page.
    fn executable(self, home: &Path) -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            let app = match self {
                Browser::Chrome => "Google Chrome.app",
                Browser::Brave => "Brave Browser.app",
            };
            [PathBuf::from("/Applications").join(app), home.join("Applications").join(app)]
                .into_iter()
                .find(|p| p.exists())
        }
        #[cfg(target_os = "windows")]
        {
            let _ = home;
            let rel = match self {
                Browser::Chrome => "Google/Chrome/Application/chrome.exe",
                Browser::Brave => "BraveSoftware/Brave-Browser/Application/brave.exe",
            };
            ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(|base| PathBuf::from(base).join(rel))
                .find(|p| p.exists())
        }
        #[cfg(target_os = "linux")]
        {
            let _ = home;
            let names: &[&str] = match self {
                Browser::Chrome => &["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
                Browser::Brave => &["brave-browser", "brave", "brave-browser-stable"],
            };
            let path = std::env::var_os("PATH")?;
            names
                .iter()
                .flat_map(|n| std::env::split_paths(&path).map(move |d| d.join(n)))
                .find(|p| p.is_file())
        }
    }
}

fn home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

/// True when any profile of the browser has our extension installed and enabled.
fn installed_in(user_data: &Path, ext_dir: Option<&Path>) -> bool {
    let Ok(entries) = std::fs::read_dir(user_data) else { return false };
    let ext_dir = ext_dir.and_then(|d| std::fs::canonicalize(d).ok());
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == "Default" || n.starts_with("Profile "))
        })
        .any(|profile| {
            ["Secure Preferences", "Preferences"].iter().any(|f| {
                let Ok(raw) = std::fs::read(profile.join(f)) else { return false };
                let Ok(json) = serde_json::from_slice::<Value>(&raw) else { return false };
                let Some(settings) = json.pointer("/extensions/settings").and_then(Value::as_object) else {
                    return false;
                };
                settings.iter().any(|(id, s)| {
                    let ours = id == EXTENSION_ID
                        || s.get("path")
                            .and_then(Value::as_str)
                            .and_then(|p| std::fs::canonicalize(p).ok())
                            .is_some_and(|p| Some(&p) == ext_dir.as_ref());
                    let disabled = s
                        .get("disable_reasons")
                        .is_some_and(|r| r.as_array().is_some_and(|a| !a.is_empty()) || r.as_u64().is_some_and(|n| n != 0));
                    ours && !disabled
                })
            })
        })
}

// --- Confirmation sent by the extension itself --------------------------------
//
// macOS blocks reading other apps' data (the browser profiles), so the
// extension tells us it is installed by opening
// `streamline://extension-installed?browser=brave`. We remember that here.

fn confirmed_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("extension-confirmed.json"))
}

fn confirmed_browsers(app: &AppHandle) -> Vec<String> {
    confirmed_file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|raw| serde_json::from_slice::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn valid_browser_id(id: &str) -> bool {
    (2..=12).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase())
}

/// Records that the extension is installed in `browser` (from a deep link).
pub fn confirm_browser(app: &AppHandle, browser: &str) {
    if !valid_browser_id(browser) {
        return;
    }
    let mut list = confirmed_browsers(app);
    if list.iter().any(|b| b == browser) {
        return;
    }
    list.push(browser.to_string());
    if let Some(file) = confirmed_file(app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, serde_json::to_vec(&list).unwrap_or_default());
    }
}

/// Handles `streamline://` links that carry an extension confirmation:
/// `extension-installed?browser=…` and `download?…&browser=…`.
pub fn handle_deep_link(app: &AppHandle, url: &tauri::Url) {
    if url.scheme() != "streamline" {
        return;
    }
    if let Some((_, browser)) = url.query_pairs().find(|(k, _)| k == "browser") {
        confirm_browser(app, &browser.to_ascii_lowercase());
    }
}

fn bundled_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("extension");
    if dir.join("manifest.json").is_file() {
        Ok(dir)
    } else {
        Err("La extensión no está incluida en esta compilación de la app".into())
    }
}

fn manifest_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read(dir.join("manifest.json")).ok()?;
    serde_json::from_slice::<Value>(&raw)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    id: &'static str,
    name: &'static str,
    /// The browser itself is installed on this computer.
    available: bool,
    /// Our extension is installed (and enabled) in some profile.
    extension_installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    /// `macos`, `windows` or `linux`: picks the right install instructions.
    os: &'static str,
    /// Where the extension lives: `<app data>/extension`.
    dir: String,
    /// macOS only: visible shortcut in the home folder (`~/Streamline Extension`),
    /// because Finder hides `~/Library` where the real folder is.
    shortcut: Option<String>,
    bundled_version: Option<String>,
    /// Version found in `dir` (None if not copied yet).
    copied_version: Option<String>,
    browsers: Vec<BrowserStatus>,
    any_installed: bool,
}

/// `<app data dir>/extension`, e.g.
/// `~/Library/Application Support/com.luisfalconmx.streamline/extension`.
fn extension_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("extension"))
}

#[cfg(target_os = "macos")]
const SHORTCUT_NAME: &str = "Streamline Extension";

fn shortcut_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        home(app).ok().map(|h| h.join(SHORTCUT_NAME))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// Creates (or repairs) the `~/Streamline Extension` symlink on macOS.
/// Never touches a real file or folder that happens to have that name.
fn ensure_shortcut(link: &Path, target: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        match std::fs::symlink_metadata(link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if std::fs::read_link(link).ok().as_deref() != Some(target) {
                    std::fs::remove_file(link).ok()?;
                    std::os::unix::fs::symlink(target, link).ok()?;
                }
            }
            Ok(_) => return None, // something else lives there: leave it alone
            Err(_) => std::os::unix::fs::symlink(target, link).ok()?,
        }
        Some(link.to_path_buf())
    }
    #[cfg(not(unix))]
    {
        let _ = (link, target);
        None
    }
}

#[tauri::command]
pub fn extension_status(app: AppHandle) -> Result<ExtensionStatus, String> {
    let home = home(&app)?;
    let dir = extension_dir(&app)?;

    let confirmed = confirmed_browsers(&app);
    let browsers: Vec<BrowserStatus> = Browser::ALL
        .into_iter()
        .map(|b| BrowserStatus {
            id: b.id(),
            name: b.name(),
            available: b.executable(&home).is_some(),
            extension_installed: confirmed.iter().any(|c| c == b.id())
                || b.user_data_dir(&home).is_some_and(|ud| installed_in(&ud, Some(&dir))),
        })
        .collect();

    let shortcut = shortcut_path(&app).filter(|l| {
        std::fs::symlink_metadata(l).is_ok_and(|m| m.file_type().is_symlink())
    });

    Ok(ExtensionStatus {
        os: std::env::consts::OS,
        dir: dir.to_string_lossy().into_owned(),
        shortcut: shortcut.map(|p| p.to_string_lossy().into_owned()),
        bundled_version: bundled_dir(&app).ok().and_then(|d| manifest_version(&d)),
        copied_version: manifest_version(&dir),
        // Edge/Opera confirmations also count even if we don't list those browsers.
        any_installed: !confirmed.is_empty() || browsers.iter().any(|b| b.extension_installed),
        browsers,
    })
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    /// Real folder inside the app data directory.
    path: String,
    /// What the user should pick in the browser (the shortcut on macOS).
    pick: String,
}

/// Copies (or updates) the bundled extension into the app data folder.
#[tauri::command]
pub fn install_extension(app: AppHandle) -> Result<InstalledExtension, String> {
    let dir = extension_dir(&app)?;
    let src = bundled_dir(&app)?;
    copy_dir(&src, &dir).map_err(|e| format!("No se pudo copiar la extensión: {e}"))?;
    let path = std::fs::canonicalize(&dir).unwrap_or(dir);
    let shortcut = shortcut_path(&app).and_then(|l| ensure_shortcut(&l, &path));
    Ok(InstalledExtension {
        pick: shortcut.as_deref().unwrap_or(&path).to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Opens `chrome://extensions` / `brave://extensions` in that browser.
#[tauri::command]
pub fn open_extensions_page(app: AppHandle, browser: String) -> Result<(), String> {
    let b = Browser::from_id(&browser).ok_or("Navegador no soportado")?;
    let exe = b
        .executable(&home(&app)?)
        .ok_or_else(|| format!("{} no está instalado", b.name()))?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-a").arg(&exe).arg(b.extensions_url());
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut c = std::process::Command::new(&exe);
        c.arg(b.extensions_url());
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("No se pudo abrir {}: {e}", b.name()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_with(dir: &Path, prefs: &str) {
        let p = dir.join("Default");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("Secure Preferences"), prefs).unwrap();
    }

    #[test]
    fn browser_ids_are_validated() {
        assert!(valid_browser_id("brave"));
        assert!(valid_browser_id("chrome"));
        assert!(!valid_browser_id("../x"));
        assert!(!valid_browser_id("a"));
        assert!(!valid_browser_id("Brave"));
    }

    #[test]
    fn detects_by_id_and_by_path() {
        let base = std::env::temp_dir().join(format!("sl-ext-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let by_id = base.join("a");
        profile_with(&by_id, &format!(r#"{{"extensions":{{"settings":{{"{EXTENSION_ID}":{{"path":"/x"}}}}}}}}"#));
        assert!(installed_in(&by_id, None));

        let ext_dir = base.join("ext");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let by_path = base.join("b");
        profile_with(
            &by_path,
            &format!(r#"{{"extensions":{{"settings":{{"other":{{"path":{:?}}}}}}}}}"#, ext_dir.to_string_lossy()),
        );
        assert!(installed_in(&by_path, Some(&ext_dir)));

        let disabled = base.join("c");
        profile_with(
            &disabled,
            &format!(r#"{{"extensions":{{"settings":{{"{EXTENSION_ID}":{{"disable_reasons":[1]}}}}}}}}"#),
        );
        assert!(!installed_in(&disabled, None));
        assert!(!installed_in(&base.join("missing"), None));
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(all(test, unix))]
mod shortcut_tests {
    use super::*;

    #[test]
    fn shortcut_is_created_repaired_and_never_overwrites_real_folders() {
        let base = std::env::temp_dir().join(format!("sl-shortcut-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let link = base.join("Streamline Extension");

        assert_eq!(ensure_shortcut(&link, &a).as_deref(), Some(link.as_path()));
        assert_eq!(std::fs::read_link(&link).unwrap(), a);
        ensure_shortcut(&link, &b).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), b);

        let real = base.join("Real Folder");
        std::fs::create_dir_all(&real).unwrap();
        assert!(ensure_shortcut(&real, &a).is_none());
        assert!(real.is_dir() && !std::fs::symlink_metadata(&real).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&base);
    }
}
