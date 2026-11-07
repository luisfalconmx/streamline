mod editor;
mod extension;
mod ytdlp;

use tauri::Manager;

fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. opening a
        // `streamline://` link) is forwarded to the running window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ytdlp::Jobs::default())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            // Linux/Windows (and dev builds) need the scheme registered at runtime;
            // macOS reads it from Info.plist, where this call is a no-op/error.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            let _ = app.deep_link().register_all();

            // Links that arrived with the launch (cold start) and later ones.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in &urls {
                    extension::handle_deep_link(app.handle(), url);
                }
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    extension::handle_deep_link(&handle, &url);
                }
                focus_main(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ytdlp::fetch_info,
            ytdlp::probe_media,
            ytdlp::probe_sizes,
            ytdlp::start_download,
            ytdlp::cancel_download,
            ytdlp::default_download_dir,
            ytdlp::tool_versions,
            ytdlp::update_ytdlp,
            ytdlp::reveal_file,
            ytdlp::open_file,
            extension::extension_status,
            editor::editor_open,
            editor::editor_keyframes,
            editor::editor_capture,
            editor::editor_allow_file,
            editor::editor_export,
            extension::install_extension,
            extension::open_extensions_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Streamline");
}
