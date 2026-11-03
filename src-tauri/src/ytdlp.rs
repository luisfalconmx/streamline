//! Thin, robust wrapper around the bundled `yt-dlp` sidecar (plus `ffmpeg`,
//! `ffprobe` and `deno`, which yt-dlp needs for merging formats and for full
//! YouTube support).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
};

const EVENT: &str = "download-event";
const PROGRESS_PREFIX: &str = "SLP|";
const POSTPROCESS_PREFIX: &str = "SLPP|";
const FILE_PREFIX: &str = "SLFILE|";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Running download jobs: job id -> OS process id.
#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, u32>>,
    cancelled: Mutex<HashSet<String>>,
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/// Directory that holds the bundled sidecars (next to the main executable,
/// both in `tauri dev` and in installed bundles).
fn sidecar_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|p| p.to_path_buf())
}

/// Returns the bundled tool if present, otherwise just its name so that the
/// system `PATH` is used as a fallback.
fn tool_path(name: &str) -> (PathBuf, bool) {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Some(dir) = sidecar_dir() {
        let candidate = dir.join(&file);
        if candidate.is_file() {
            return (candidate, true);
        }
    }
    (PathBuf::from(file), false)
}

fn command(name: &str) -> Command {
    let (path, _) = tool_path(name);
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A yt-dlp command pre-configured with the bundled helpers.
fn ytdlp(cookies_browser: Option<&str>) -> Command {
    let mut cmd = command("yt-dlp");
    cmd.args(["--ignore-config", "--no-warnings", "--no-color"]);

    let (ffmpeg, bundled_ffmpeg) = tool_path("ffmpeg");
    if bundled_ffmpeg {
        if let Some(dir) = ffmpeg.parent() {
            cmd.arg("--ffmpeg-location").arg(dir);
        }
    }
    let (deno, bundled_deno) = tool_path("deno");
    if bundled_deno {
        cmd.arg("--js-runtimes")
            .arg(format!("deno:{}", deno.to_string_lossy()));
    }
    if let Some(browser) = cookies_browser.filter(|b| !b.is_empty()) {
        cmd.arg("--cookies-from-browser").arg(browser);
    }
    cmd
}

fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim().to_string())
        .or_else(|| {
            stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
        })
        .unwrap_or_else(|| "yt-dlp terminó con un error desconocido".into())
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "No se encontró yt-dlp. Ejecuta `pnpm sidecars` para descargar los binarios.".into()
    } else {
        format!("No se pudo ejecutar yt-dlp: {e}")
    }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/// Drops heavy fields that the UI never uses so the IPC payload stays small.
fn slim(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        for key in [
            "automatic_captions",
            "heatmap",
            "requested_formats",
            "requested_downloads",
            "_format_sort_fields",
            "http_headers",
        ] {
            obj.remove(key);
        }
        if let Some(Value::Array(formats)) = obj.get_mut("formats") {
            for f in formats.iter_mut().filter_map(Value::as_object_mut) {
                for key in ["fragments", "http_headers", "url", "manifest_url", "downloader_options"] {
                    f.remove(key);
                }
            }
        }
        if let Some(Value::Object(subs)) = obj.get_mut("subtitles") {
            let langs: Vec<Value> = subs.keys().cloned().map(Value::String).collect();
            obj.insert("subtitle_langs".into(), Value::Array(langs));
            obj.remove("subtitles");
        }
    }
    v
}

#[tauri::command]
pub async fn fetch_info(url: String, cookies_browser: Option<String>) -> Result<Value, String> {
    let mut cmd = ytdlp(cookies_browser.as_deref());
    cmd.args(["-J", "--flat-playlist", "--no-playlist", "--"]).arg(url.trim());

    let output = tokio::time::timeout(Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| "Tiempo de espera agotado al obtener la información".to_string())?
        .map_err(spawn_error)?;

    if !output.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Respuesta inválida de yt-dlp: {e}"))?;
    Ok(slim(json))
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub id: String,
    pub url: String,
    /// yt-dlp format selector (`-f`).
    pub format: String,
    pub output_dir: String,
    /// When set, extract audio to this codec (`mp3`, `m4a`, `opus`, `flac`, `wav`, `best`).
    pub audio_format: Option<String>,
    /// `0` (best VBR) or a bitrate such as `192K`.
    pub audio_quality: Option<String>,
    /// Container used when merging video + audio (`mp4`, `mkv`, `webm`).
    pub merge_format: Option<String>,
    #[serde(default)]
    pub embed_subs: bool,
    pub sub_langs: Option<String>,
    #[serde(default)]
    pub embed_thumbnail: bool,
    #[serde(default)]
    pub embed_metadata: bool,
    #[serde(default)]
    pub sponsorblock: bool,
    pub concurrent_fragments: Option<u32>,
    pub cookies_browser: Option<String>,
    pub filename_template: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DlEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        id: String,
        status: String,
        downloaded: Option<f64>,
        total: Option<f64>,
        speed: Option<f64>,
        eta: Option<f64>,
        stream: String,
        fragment_index: Option<f64>,
        fragment_count: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Stage { id: String, stage: String },
    #[serde(rename_all = "camelCase")]
    File { id: String, path: String },
    #[serde(rename_all = "camelCase")]
    Done { id: String },
    #[serde(rename_all = "camelCase")]
    Error { id: String, message: String },
    #[serde(rename_all = "camelCase")]
    Cancelled { id: String },
}

fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn parse_progress(id: &str, line: &str) -> Option<DlEvent> {
    let rest = line.strip_prefix(PROGRESS_PREFIX)?;
    let p: Vec<&str> = rest.split('|').collect();
    if p.len() < 10 {
        return None;
    }
    let total = num(p[2]).or_else(|| num(p[3]));
    let (vcodec, acodec) = (p[8].trim(), p[9].trim());
    let stream = match (vcodec, acodec) {
        ("none", _) => "audio",
        (_, "none") => "video",
        _ => "av",
    };
    Some(DlEvent::Progress {
        id: id.to_string(),
        status: p[0].trim().to_string(),
        downloaded: num(p[1]),
        total,
        speed: num(p[4]),
        eta: num(p[5]),
        fragment_index: num(p[6]),
        fragment_count: num(p[7]),
        stream: stream.into(),
    })
}

fn build_args(req: &DownloadRequest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut push = |s: &str| a.push(s.to_string());

    // Machine-readable progress on stdout.
    push("--quiet");
    push("--progress");
    push("--newline");
    push("--progress-delta");
    push("0.4");
    push("--progress-template");
    push(&format!(
        "download:{PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.vcodec)s|%(info.acodec)s"
    ));
    push("--progress-template");
    push(&format!(
        "postprocess:{POSTPROCESS_PREFIX}%(progress.status)s|%(progress.postprocessor)s"
    ));
    push("--print");
    push(&format!("after_move:{FILE_PREFIX}%(filepath)s"));

    // Speed: parallel fragment downloads, re-extract when throttled, no rate limit.
    let n = req.concurrent_fragments.unwrap_or(8).clamp(1, 32);
    push("--concurrent-fragments");
    push(&n.to_string());
    push("--throttled-rate");
    push("100K");
    push("--retries");
    push("10");
    push("--fragment-retries");
    push("10");

    push("--no-playlist");
    push("--no-mtime");
    push("--continue");

    push("-P");
    push(&req.output_dir);
    push("-o");
    push(
        req.filename_template
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or("%(title).180B.%(ext)s"),
    );

    push("-f");
    push(&req.format);

    if let Some(af) = req.audio_format.as_deref().filter(|s| !s.is_empty()) {
        push("--extract-audio");
        push("--audio-format");
        push(af);
        push("--audio-quality");
        push(req.audio_quality.as_deref().unwrap_or("0"));
    } else {
        if let Some(mf) = req.merge_format.as_deref().filter(|s| !s.is_empty()) {
            push("--merge-output-format");
            push(mf);
        }
        if req.embed_subs {
            push("--embed-subs");
            push("--sub-langs");
            push(req.sub_langs.as_deref().unwrap_or("es.*,en.*"));
        }
    }
    if req.embed_thumbnail {
        push("--embed-thumbnail");
    }
    if req.embed_metadata {
        push("--embed-metadata");
        push("--embed-chapters");
    }
    if req.sponsorblock {
        push("--sponsorblock-remove");
        push("sponsor,selfpromo,interaction");
    }
    push("--");
    push(&req.url);
    a
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    request: DownloadRequest,
) -> Result<(), String> {
    std::fs::create_dir_all(&request.output_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de destino: {e}"))?;

    let mut cmd = ytdlp(request.cookies_browser.as_deref());
    cmd.args(build_args(&request));
    #[cfg(unix)]
    {
        // Own process group so cancelling also stops ffmpeg children.
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(spawn_error)?;
    let id = request.id.clone();
    if let Some(pid) = child.id() {
        jobs.running.lock().await.insert(id.clone(), pid);
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app_out = app.clone();
    let id_out = id.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end_matches('\r');
            let event = if let Some(ev) = parse_progress(&id_out, line) {
                Some(ev)
            } else if let Some(rest) = line.strip_prefix(POSTPROCESS_PREFIX) {
                let mut it = rest.splitn(2, '|');
                let status = it.next().unwrap_or_default();
                let pp = it.next().unwrap_or_default();
                (status == "started").then(|| DlEvent::Stage {
                    id: id_out.clone(),
                    stage: pp.to_string(),
                })
            } else {
                line.strip_prefix(FILE_PREFIX).map(|path| DlEvent::File {
                    id: id_out.clone(),
                    path: path.to_string(),
                })
            };
            if let Some(ev) = event {
                let _ = app_out.emit(EVENT, ev);
            }
        }
    });

    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = out_task.await;
        let stderr = err_task.await.unwrap_or_default();
        let jobs = app.state::<Jobs>();
        jobs.running.lock().await.remove(&id);
        let was_cancelled = jobs.cancelled.lock().await.remove(&id);

        let event = if was_cancelled {
            DlEvent::Cancelled { id }
        } else {
            match status {
                Ok(s) if s.success() => DlEvent::Done { id },
                Ok(_) => DlEvent::Error {
                    id,
                    message: last_error(&stderr),
                },
                Err(e) => DlEvent::Error {
                    id,
                    message: e.to_string(),
                },
            }
        };
        let _ = app.emit(EVENT, event);
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_download(jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    let pid = jobs.running.lock().await.get(&id).copied();
    let Some(pid) = pid else { return Ok(()) };
    jobs.cancelled.lock().await.insert(id);

    #[cfg(unix)]
    unsafe {
        // Negative pid targets the whole process group created at spawn.
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = kill.status().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn default_download_dir(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("Streamline").to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersions {
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
    deno: Option<String>,
}

async fn first_line(name: &str, arg: &str) -> Option<String> {
    let out = command(name).arg(arg).output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
}

#[tauri::command]
pub async fn tool_versions() -> ToolVersions {
    let (ytdlp, ffmpeg, deno) = tokio::join!(
        first_line("yt-dlp", "--version"),
        first_line("ffmpeg", "-version"),
        first_line("deno", "--version"),
    );
    ToolVersions {
        ytdlp,
        ffmpeg: ffmpeg.map(|l| {
            l.split_whitespace()
                .nth(2)
                .map(str::to_string)
                .unwrap_or(l)
        }),
        deno: deno.map(|l| l.trim_start_matches("deno ").split(' ').next().unwrap_or("").to_string()),
    }
}

#[tauri::command]
pub async fn update_ytdlp() -> Result<String, String> {
    let out = command("yt-dlp")
        .arg("-U")
        .output()
        .await
        .map_err(spawn_error)?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(last_error(&text))
    }
}

#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}
