mod ytdlp;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ytdlp::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            ytdlp::fetch_info,
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
