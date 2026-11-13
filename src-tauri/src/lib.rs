mod scrape;
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
        // Must be the first plugin: a second launch focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ytdlp::Jobs::default())
        .setup(|app| {
            ytdlp::clear_stale_temp(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ytdlp::fetch_info,
            scrape::scrape_page,
            ytdlp::probe_media,
            ytdlp::probe_sizes,
            ytdlp::start_download,
            ytdlp::cancel_download,
            ytdlp::default_download_dir,
            ytdlp::tool_versions,
            ytdlp::update_ytdlp,
            ytdlp::reveal_file,
            ytdlp::open_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Streamline");
}
