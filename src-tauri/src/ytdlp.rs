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
fn ytdlp(cookies_browser: Option<&str>, referer: Option<&str>) -> Command {
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
    if let Some(r) = valid_http_url(referer) {
        cmd.arg("--referer").arg(r);
    }
    cmd
}

fn valid_http_url(s: Option<&str>) -> Option<&str> {
    s.map(str::trim)
        .filter(|u| (u.starts_with("http://") || u.starts_with("https://")) && !u.contains(char::is_whitespace))
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
pub async fn fetch_info(
    url: String,
    cookies_browser: Option<String>,
    referer: Option<String>,
) -> Result<Value, String> {
    let mut cmd = ytdlp(cookies_browser.as_deref(), referer.as_deref());
    cmd.args(["-J", "--flat-playlist", "--no-playlist", "--"]).arg(url.trim());

    let output = tokio::time::timeout(Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| "Tiempo de espera agotado al obtener la información".to_string())?
        .map_err(spawn_error)?;

    if !output.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let mut json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Respuesta inválida de yt-dlp: {e}"))?;
    probe_direct_formats(&mut json).await;
    Ok(slim(json))
}

// ---------------------------------------------------------------------------
// HTTP probing for direct links
// ---------------------------------------------------------------------------

/// Maps a `Content-Type` to a file extension and whether it is audio-only.
fn ext_from_content_type(ct: &str) -> Option<(&'static str, bool)> {
    let ct = ct.split(';').next()?.trim().to_ascii_lowercase();
    Some(match ct.as_str() {
        "video/mp4" | "video/x-m4v" => ("mp4", false),
        "video/webm" => ("webm", false),
        "video/quicktime" => ("mov", false),
        "video/x-matroska" => ("mkv", false),
        "video/x-flv" => ("flv", false),
        "video/x-msvideo" => ("avi", false),
        "video/mp2t" => ("ts", false),
        "video/3gpp" => ("3gp", false),
        "video/ogg" => ("ogv", false),
        "audio/mpeg" | "audio/mp3" => ("mp3", true),
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => ("m4a", true),
        "audio/ogg" => ("ogg", true),
        "audio/opus" => ("opus", true),
        "audio/wav" | "audio/x-wav" | "audio/wave" => ("wav", true),
        "audio/flac" | "audio/x-flac" => ("flac", true),
        "audio/webm" => ("weba", true),
        _ => return None,
    })
}

/// Extensions yt-dlp accepts as media containers. Anything else coming from a
/// direct link (e.g. `remote_control.php`) is a server script name, not the
/// real file type, and yt-dlp refuses to save it "for safety reasons".
fn is_media_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "flv" | "avi" | "ts" | "3gp" | "ogv" | "wmv" | "mpg" | "mpeg"
            | "mp3" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "wav" | "flac" | "weba" | "mka"
            | "m3u8" | "mpd" | "f4m" | "ism"
    )
}

struct Probe {
    size: Option<u64>,
    content_type: Option<String>,
}

/// HEAD request (falling back to a 1-byte ranged GET for servers that reject
/// HEAD) to learn the real size and media type of a direct file.
async fn probe_url(client: &reqwest::Client, url: &str, headers: &serde_json::Map<String, Value>) -> Option<Probe> {
    let mut hm = reqwest::header::HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(name), Some(Ok(val))) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            v.as_str().map(reqwest::header::HeaderValue::from_str),
        ) {
            hm.insert(name, val);
        }
    }
    let ct_of = |r: &reqwest::Response| {
        r.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };

    if let Ok(r) = client.head(url).headers(hm.clone()).send().await {
        if r.status().is_success() {
            let size = r
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
                .filter(|n| *n > 0);
            if size.is_some() {
                return Some(Probe { size, content_type: ct_of(&r) });
            }
        }
    }

    let r = client
        .get(url)
        .headers(hm)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    // `Content-Range: bytes 0-0/12345`
    let size = r
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|n| n.parse::<u64>().ok())
        .or_else(|| (r.status() == reqwest::StatusCode::OK).then(|| r.content_length()).flatten());
    Some(Probe { size, content_type: ct_of(&r) })
}

/// For the generic extractor yt-dlp often knows nothing about a direct file
/// except its URL: no size, no codecs and sometimes no extension. Fill the gaps
/// from the HTTP headers so the UI can show the size and the right media type.
async fn probe_direct_formats(info: &mut Value) {
    let generic = info.get("extractor_key").and_then(Value::as_str) == Some("Generic")
        || info.get("direct").and_then(Value::as_bool) == Some(true);
    if !generic {
        return;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
    else {
        return;
    };

    let mut total: Option<u64> = None;
    if let Some(Value::Array(formats)) = info.get_mut("formats") {
        for f in formats.iter_mut().rev().take(4).filter_map(Value::as_object_mut) {
            let known = f.get("filesize").is_some_and(|v| !v.is_null())
                || f.get("filesize_approx").is_some_and(|v| !v.is_null());
            let proto = f.get("protocol").and_then(Value::as_str).unwrap_or("https");
            let Some(url) = f.get("url").and_then(Value::as_str).map(str::to_string) else { continue };
            if known || !proto.starts_with("http") {
                continue;
            }
            let headers = f
                .get("http_headers")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let Some(p) = probe_url(&client, &url, &headers).await else { continue };

            if let Some(size) = p.size {
                f.insert("filesize".into(), size.into());
                total = Some(total.map_or(size, |t| t.max(size)));
            }
            if let Some((ext, audio_only)) = p.content_type.as_deref().and_then(ext_from_content_type) {
                let ext_missing = f
                    .get("ext")
                    .and_then(Value::as_str)
                    .is_none_or(|e| !is_media_ext(e));
                if ext_missing {
                    f.insert("ext".into(), ext.into());
                }
                if f.get("vcodec").is_none_or(Value::is_null) && audio_only {
                    f.insert("vcodec".into(), "none".into());
                }
            }
        }
    }
    if let (Some(size), Some(obj)) = (total, info.as_object_mut()) {
        obj.entry("filesize").or_insert(size.into());
    }
}

// ---------------------------------------------------------------------------
// Media preview for direct links (thumbnail + technical metadata via ffmpeg)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreview {
    /// `data:image/jpeg;base64,…`
    thumbnail: Option<String>,
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    vcodec: Option<String>,
    acodec: Option<String>,
}

/// The bundled ffmpeg uses OpenSSL and does not know where the OS keeps its
/// trusted certificates, so point it at the system bundle when there is one.
fn ca_bundle() -> Option<&'static str> {
    [
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).is_file())
}

fn parse_hms(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':').rev();
    let sec: f64 = parts.next()?.parse().ok()?;
    let min: f64 = parts.next().unwrap_or("0").parse().ok()?;
    let hour: f64 = parts.next().unwrap_or("0").parse().ok()?;
    Some(hour * 3600.0 + min * 60.0 + sec)
}

/// Extracts duration and the first video/audio stream from ffmpeg's banner.
fn parse_ffmpeg_banner(stderr: &str, p: &mut MediaPreview) {
    // Only the input section; the output section describes our JPEG.
    let input = stderr.split("Output #0").next().unwrap_or(stderr);
    for line in input.lines().map(str::trim) {
        if p.duration.is_none() {
            if let Some(rest) = line.strip_prefix("Duration: ") {
                p.duration = rest.split(',').next().and_then(parse_hms).filter(|d| *d > 0.0);
            }
        }
        if p.vcodec.is_none() {
            if let Some(rest) = line.split("Video: ").nth(1) {
                p.vcodec = rest.split([' ', ',']).next().map(str::to_string);
                if let Some(dim) = rest
                    .split([' ', ','])
                    .find(|t| t.contains('x') && t.split('x').all(|n| n.parse::<u32>().is_ok()))
                {
                    let mut it = dim.split('x').map(|n| n.parse::<u32>().ok());
                    p.width = it.next().flatten();
                    p.height = it.next().flatten();
                }
                p.fps = rest
                    .split(", ")
                    .find_map(|t| t.strip_suffix(" fps"))
                    .and_then(|f| f.trim().parse().ok());
            }
        }
        if p.acodec.is_none() {
            if let Some(rest) = line.split("Audio: ").nth(1) {
                p.acodec = rest.split([' ', ',']).next().map(str::to_string);
            }
        }
    }
}

/// Grabs a frame and the technical metadata of a remote video with ffmpeg.
/// Used for direct file links, which come without thumbnail or duration.
#[tauri::command]
pub async fn probe_media(url: String, referer: Option<String>) -> Result<MediaPreview, String> {
    use base64::Engine as _;
    let url = valid_http_url(Some(&url)).ok_or("URL inválida")?.to_string();

    let run = |seek: &'static str| {
        let mut cmd = command("ffmpeg");
        cmd.args(["-hide_banner", "-nostdin", "-rw_timeout", "20000000"]);
        if let Some(ca) = ca_bundle() {
            cmd.args(["-ca_file", ca]);
        }
        if let Some(r) = valid_http_url(referer.as_deref()) {
            cmd.arg("-headers").arg(format!("Referer: {r}\r\n"));
        }
        cmd.args(["-ss", seek, "-i"]).arg(&url).args([
            "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
        ]);
        tokio::time::timeout(Duration::from_secs(45), cmd.output())
    };

    let mut out = run("15")
        .await
        .map_err(|_| "Tiempo de espera agotado".to_string())?
        .map_err(|e| e.to_string())?;
    // Short clips: seeking past the end yields no frame, retry from the start.
    if out.stdout.is_empty() {
        if let Ok(Ok(o)) = run("0").await {
            out = o;
        }
    }

    let mut preview = MediaPreview::default();
    parse_ffmpeg_banner(&String::from_utf8_lossy(&out.stderr), &mut preview);
    if !out.stdout.is_empty() {
        preview.thumbnail = Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&out.stdout)
        ));
    }
    if preview.thumbnail.is_none() && preview.duration.is_none() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(preview)
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
    /// Remux a single (non-merged) video file into `merge_format` — used for
    /// direct links whose container may differ from the one the user picked.
    #[serde(default)]
    pub remux_video: bool,
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
    /// Forced output extension for direct links whose URL lies about the type.
    pub ext: Option<String>,
    /// Readable file name to use instead of `%(title)s` (direct links).
    pub title: Option<String>,
    /// Page the video was found on (sent by the browser extension).
    pub referer: Option<String>,
}

const DEFAULT_TEMPLATE: &str = "%(title).180B.%(ext)s";

/// Short, stable FNV-1a hash used to make every file name unique.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    trimmed.chars().take(150).collect::<String>().replace('%', "%%")
}

/// Builds the `-o` template: optional literal title and extension, plus a
/// ` [hash]` suffix so downloads with the same title never overwrite each other.
fn output_template(req: &DownloadRequest) -> String {
    let mut tmpl = req
        .filename_template
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(DEFAULT_TEMPLATE)
        .to_string();

    if let Some(title) = req.title.as_deref().map(sanitize_filename).filter(|t| !t.is_empty()) {
        tmpl = tmpl.replace("%(title).180B", &title).replace("%(title)s", &title);
    }
    let ext = forced_ext(req);

    // Direct links carry rotating tokens in the query string; hash the path so
    // the same file keeps the same name. Everything else hashes the full URL.
    let source = if ext.is_some() {
        req.url.split(['?', '#']).next().unwrap_or(&req.url)
    } else {
        &req.url
    };
    let tag = format!(" [{}]", short_hash(source));
    match tmpl.strip_suffix(".%(ext)s") {
        Some(stem) => format!("{stem}{tag}.%(ext)s"),
        None => format!("{tmpl}{tag}"),
    }
}

/// Real media extension for a direct link (from its `Content-Type`), if any.
fn forced_ext(req: &DownloadRequest) -> Option<String> {
    req.ext
        .as_deref()
        .map(str::to_ascii_lowercase)
        .filter(|e| is_media_ext(e) && !matches!(e.as_str(), "m3u8" | "mpd" | "f4m" | "ism"))
}

/// Direct links: yt-dlp takes the extension from the final redirect URL, which
/// is often a server script (`remote_control.php`), and then refuses to save
/// the file. Extract the info ourselves, put the real media extension in it and
/// hand it back to yt-dlp with `--load-info-json`, keeping its safety checks on.
async fn prepare_direct_info(cache_dir: PathBuf, req: &DownloadRequest, ext: &str) -> Result<PathBuf, String> {
    let mut cmd = ytdlp(req.cookies_browser.as_deref(), req.referer.as_deref());
    cmd.args(["-J", "--no-playlist", "--"]).arg(&req.url);
    let output = tokio::time::timeout(Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| "Tiempo de espera agotado al preparar la descarga".to_string())?
        .map_err(spawn_error)?;
    if !output.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let mut info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Respuesta inválida de yt-dlp: {e}"))?;

    let fix = |obj: &mut serde_json::Map<String, Value>| {
        let bad = obj.get("ext").and_then(Value::as_str).is_none_or(|e| !is_media_ext(e));
        if bad {
            obj.insert("ext".into(), ext.into());
        }
    };
    if let Some(obj) = info.as_object_mut() {
        fix(obj);
        if let Some(Value::Array(formats)) = obj.get_mut("formats") {
            formats.iter_mut().filter_map(Value::as_object_mut).for_each(fix);
        }
    }

    let dir = cache_dir.join("info");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.info.json", req.id.replace(|c: char| !c.is_ascii_alphanumeric(), "_")));
    std::fs::write(&path, serde_json::to_vec(&info).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path)
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

fn build_args(req: &DownloadRequest, info_json: Option<&std::path::Path>) -> Vec<String> {
    let template = output_template(req);
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
    push(&template);

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
            // WebM only accepts VP8/VP9/AV1 + Vorbis/Opus, so remuxing an arbitrary
            // direct file into it would fail; keep the original container instead.
            if req.remux_video && mf != "webm" {
                push("--remux-video");
                push(mf);
            }
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
    match info_json {
        Some(path) => {
            push("--load-info-json");
            push(&path.to_string_lossy());
        }
        None => {
            push("--");
            push(&req.url);
        }
    }
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

    let info_json = match forced_ext(&request) {
        Some(ext) => {
            let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
            Some(prepare_direct_info(cache, &request, &ext).await?)
        }
        None => None,
    };

    let mut cmd = ytdlp(request.cookies_browser.as_deref(), request.referer.as_deref());
    cmd.args(build_args(&request, info_json.as_deref()));
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
        if let Some(path) = &info_json {
            let _ = std::fs::remove_file(path);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str, ext: Option<&str>, title: Option<&str>) -> DownloadRequest {
        serde_json::from_value(serde_json::json!({
            "id": "t", "url": url, "format": "b", "outputDir": "/tmp",
            "ext": ext, "title": title, "filenameTemplate": DEFAULT_TEMPLATE
        }))
        .unwrap()
    }

    #[test]
    fn template_adds_hash_before_extension() {
        let t = output_template(&req("https://www.youtube.com/watch?v=abc", None, None));
        assert!(t.starts_with("%(title).180B ["), "{t}");
        assert!(t.ends_with("].%(ext)s"), "{t}");
    }

    #[test]
    fn different_urls_get_different_names() {
        let a = output_template(&req("https://site.com/get_file/1/a.mp4/?t=1", Some("mp4"), Some("a")));
        let b = output_template(&req("https://site.com/get_file/2/b.mp4/?t=1", Some("mp4"), Some("a")));
        assert_ne!(a, b);
    }

    #[test]
    fn direct_links_use_literal_title_and_ext_and_ignore_tokens() {
        let a = output_template(&req("https://s.com/get_file/3114894_1080p.mp4/?tok=1", Some("mp4"), Some("3114894_1080p")));
        let b = output_template(&req("https://s.com/get_file/3114894_1080p.mp4/?tok=2", Some("mp4"), Some("3114894_1080p")));
        assert_eq!(a, b);
        assert!(a.starts_with("3114894_1080p [") && a.ends_with("].%(ext)s"), "{a}");
    }

    #[test]
    fn script_extensions_are_not_media() {
        assert!(!is_media_ext("php"));
        assert!(is_media_ext("MP4"));
        assert_eq!(forced_ext(&req("https://s.com/x", Some("php"), None)), None);
        assert_eq!(forced_ext(&req("https://s.com/x", Some("MP4"), None)).as_deref(), Some("mp4"));
    }

    #[test]
    fn parses_ffmpeg_banner() {
        let banner = "Input #0, mov,mp4, from 'x':\n  Duration: 00:36:06.33, start: 0.000000, bitrate: 7044 kb/s\n  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 6738 kb/s, 60 fps, 60 tbr, 15360 tbn (default)\n  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo\nOutput #0, image2pipe, to 'pipe:':\n  Stream #0:0(eng): Video: mjpeg, yuv420p, 480x270, 60 fps\n";
        let mut p = MediaPreview::default();
        parse_ffmpeg_banner(banner, &mut p);
        assert_eq!(p.duration.map(|d| d.round()), Some(2166.0));
        assert_eq!((p.width, p.height), (Some(1920), Some(1080)));
        assert_eq!(p.fps, Some(60.0));
        assert_eq!(p.vcodec.as_deref(), Some("h264"));
        assert_eq!(p.acodec.as_deref(), Some("aac"));
    }

    #[test]
    fn sanitizes_titles() {
        assert_eq!(sanitize_filename("a/b:c?100%"), "a_b_c_100%%");
    }
}
