//! Basic video editor: remove parts of a video, change its title and cover.
//!
//! Default mode is lossless: segments are copied with ffmpeg (`-c copy`), so
//! a 4K video stays bit-for-bit the same 4K video. Copy cuts must start on a
//! keyframe, so the UI snaps cut points to the keyframes reported here. The
//! optional "precise" mode re-encodes with high quality (CRF 16/18) to cut on
//! any frame, keeping resolution and frame rate.

use crate::ytdlp::command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};

const PROGRESS_EVENT: &str = "editor-progress";

/// Containers the webview can play directly.
const PLAYABLE: &[&str] = &["mp4", "m4v", "mov", "webm"];

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn work_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("editor");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn allow_in_webview<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    let _ = app.asset_protocol_scope().allow_file(path);
}

fn ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("ffmpeg falló")
        .trim()
        .to_string()
}

async fn run(mut cmd: tokio::process::Command, secs: u64) -> Result<std::process::Output, String> {
    let out = tokio::time::timeout(Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| "La operación tardó demasiado".to_string())?
        .map_err(|e| format!("No se pudo ejecutar ffmpeg: {e}"))?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(ffmpeg_error(&out.stderr))
    }
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct Streams {
    video: Option<usize>,
    audio: Vec<usize>,
    subtitles: Vec<usize>,
    cover: Option<usize>,
    cover_codec: Option<String>,
}

fn parse_streams(probe: &Value) -> Streams {
    let mut s = Streams::default();
    for st in probe["streams"].as_array().into_iter().flatten() {
        let idx = st["index"].as_u64().unwrap_or(0) as usize;
        let attached = st["disposition"]["attached_pic"].as_u64() == Some(1);
        match st["codec_type"].as_str() {
            Some("video") if attached => {
                s.cover = Some(idx);
                s.cover_codec = st["codec_name"].as_str().map(str::to_string);
            }
            Some("video") if s.video.is_none() => s.video = Some(idx),
            Some("audio") => s.audio.push(idx),
            Some("subtitle") => s.subtitles.push(idx),
            _ => {}
        }
    }
    s
}

async fn ffprobe(path: &Path) -> Result<Value, String> {
    let mut cmd = command("ffprobe");
    cmd.args(["-v", "error", "-show_format", "-show_streams", "-of", "json"]).arg(path);
    let out = run(cmd, 60).await?;
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

fn parse_rate(r: &str) -> Option<f64> {
    let (n, d) = r.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d > 0.0 && n > 0.0).then(|| n / d)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorMedia {
    path: String,
    /// File the webview should play (a remuxed copy for MKV & co.), if any.
    preview_path: Option<String>,
    file_name: String,
    container: String,
    duration: f64,
    size: Option<u64>,
    width: Option<u64>,
    height: Option<u64>,
    fps: Option<f64>,
    vcodec: Option<String>,
    acodec: Option<String>,
    title: Option<String>,
    /// Embedded cover extracted to a temporary JPEG/PNG, if the file has one.
    cover_path: Option<String>,
    /// Whether the container can store a cover image.
    cover_supported: bool,
}

/// Opens a video for editing: metadata, playable preview and current cover.
#[tauri::command]
pub async fn editor_open<R: Runtime>(app: AppHandle<R>, path: String) -> Result<EditorMedia, String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err("El archivo no existe".into());
    }
    let probe = ffprobe(&path).await?;
    let streams = parse_streams(&probe);
    let vidx = streams.video.ok_or("El archivo no tiene video")?;
    let vs = probe["streams"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["index"].as_u64() == Some(vidx as u64)))
        .cloned()
        .unwrap_or_default();
    let acodec = streams.audio.first().and_then(|i| {
        probe["streams"]
            .as_array()?
            .iter()
            .find(|s| s["index"].as_u64() == Some(*i as u64))?["codec_name"]
            .as_str()
            .map(str::to_string)
    });
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| vs["duration"].as_str().and_then(|d| d.parse().ok()))
        .unwrap_or(0.0);
    let container = ext_of(&path);
    let dir = work_dir(&app)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // Preview: browsers can't play MKV/AVI/FLV; remux (no re-encode) to MP4.
    let preview = if PLAYABLE.contains(&container.as_str()) {
        Some(path.clone())
    } else {
        let out = dir.join(format!("preview-{stamp}.mp4"));
        let mut cmd = command("ffmpeg");
        cmd.args(["-y", "-v", "error", "-i"])
            .arg(&path)
            .args(["-map", &format!("0:{vidx}")]);
        if let Some(a) = streams.audio.first() {
            cmd.args(["-map", &format!("0:{a}")]);
        }
        cmd.args(["-c", "copy", "-movflags", "+faststart"]).arg(&out);
        run(cmd, 600).await.ok().map(|_| out)
    };
    if let Some(p) = &preview {
        allow_in_webview(&app, p);
    }

    // Current cover (yt-dlp embeds the thumbnail as an attached picture).
    let cover_path = match (streams.cover, &streams.cover_codec) {
        (Some(idx), codec) => {
            let ext = if codec.as_deref() == Some("png") { "png" } else { "jpg" };
            let out = dir.join(format!("cover-{stamp}.{ext}"));
            let mut cmd = command("ffmpeg");
            cmd.args(["-y", "-v", "error", "-i"])
                .arg(&path)
                .args(["-map", &format!("0:{idx}"), "-c", "copy", "-frames:v", "1"])
                .arg(&out);
            run(cmd, 60).await.ok().map(|_| {
                allow_in_webview(&app, &out);
                out.to_string_lossy().into_owned()
            })
        }
        _ => None,
    };

    Ok(EditorMedia {
        path: path.to_string_lossy().into_owned(),
        preview_path: preview.map(|p| p.to_string_lossy().into_owned()),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        cover_supported: matches!(container.as_str(), "mp4" | "m4v" | "mov" | "mkv"),
        container,
        duration,
        size: std::fs::metadata(&path).ok().map(|m| m.len()),
        width: vs["width"].as_u64(),
        height: vs["height"].as_u64(),
        fps: vs["avg_frame_rate"].as_str().and_then(parse_rate),
        vcodec: vs["codec_name"].as_str().map(str::to_string),
        acodec,
        title: probe["format"]["tags"]["title"]
            .as_str()
            .or_else(|| probe["format"]["tags"]["TITLE"].as_str())
            .map(str::to_string),
        cover_path,
    })
}

/// Keyframe timestamps of the main video stream (packet flags, no decoding).
#[tauri::command]
pub async fn editor_keyframes(path: String) -> Result<Vec<f64>, String> {
    let mut cmd = command("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
    ])
    .arg(&path);
    let out = run(cmd, 300).await?;
    let mut keys: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (t, flags) = l.split_once(',')?;
            flags.contains('K').then(|| t.parse::<f64>().ok()).flatten()
        })
        .collect();
    keys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    keys.dedup();
    Ok(keys)
}

/// Grabs the frame at `time` at full resolution (for the cover).
#[tauri::command]
pub async fn editor_capture<R: Runtime>(app: AppHandle<R>, path: String, time: f64) -> Result<String, String> {
    let out = work_dir(&app)?.join(format!(
        "frame-{}.jpg",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let mut cmd = command("ffmpeg");
    cmd.args(["-y", "-v", "error", "-ss", &format!("{:.3}", time.max(0.0)), "-i"])
        .arg(&path)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(&out);
    run(cmd, 60).await?;
    allow_in_webview(&app, &out);
    Ok(out.to_string_lossy().into_owned())
}

/// Lets the webview show an image the user picked as cover.
#[tauri::command]
pub fn editor_allow_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let ok = matches!(ext_of(&p).as_str(), "jpg" | "jpeg" | "png" | "webp");
    if !ok || !p.is_file() {
        return Err("Elige una imagen JPG, PNG o WebP".into());
    }
    allow_in_webview(&app, &p);
    Ok(())
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    job_id: String,
    path: String,
    /// Parts to keep, in seconds: `[[start, end], …]`.
    keep: Vec<[f64; 2]>,
    title: Option<String>,
    cover_path: Option<String>,
    /// Re-encode to cut on any frame (otherwise lossless stream copy).
    #[serde(default)]
    precise: bool,
    /// `original` replaces the file, `copy` writes a new one next to it.
    save_as: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    /// 0..1
    progress: f64,
    stage: String,
}

fn emit<R: Runtime>(app: &AppHandle<R>, job: &str, progress: f64, stage: &str) {
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress {
            job_id: job.to_string(),
            progress: progress.clamp(0.0, 1.0),
            stage: stage.to_string(),
        },
    );
}

/// Runs ffmpeg with `-progress pipe:1` and reports `done + share * fraction`.
async fn run_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    job: &str,
    mut cmd: tokio::process::Command,
    total: f64,
    done: f64,
    share: f64,
    stage: &str,
) -> Result<(), String> {
    cmd.args(["-progress", "pipe:1", "-nostats"]);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("sin salida")?;
    let stderr = child.stderr.take().ok_or("sin salida")?;
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut r = BufReader::new(stderr);
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut r, &mut buf).await;
        buf
    });
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if total > 0.0 {
                emit(app, job, done + share * (us / 1e6 / total).min(1.0), stage);
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(ffmpeg_error(&stderr))
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    cleaned.trim().trim_matches('.').chars().take(150).collect()
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

/// Normalises the parts to keep: sorted, inside the video, without overlaps.
fn clean_ranges(keep: &[[f64; 2]], duration: f64) -> Vec<(f64, f64)> {
    let mut r: Vec<(f64, f64)> = keep
        .iter()
        .map(|[a, b]| (a.max(0.0), if duration > 0.0 { b.min(duration) } else { *b }))
        .filter(|(a, b)| b - a > 0.05)
        .collect();
    r.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (a, b) in r {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    merged
}

fn concat_line(p: &Path) -> String {
    // ffconcat quoting: single quotes, with ' escaped as '\''
    format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn editor_export<R: Runtime>(app: AppHandle<R>, request: ExportRequest) -> Result<String, String> {
    let src = PathBuf::from(&request.path);
    if !src.is_file() {
        return Err("El archivo original ya no existe".into());
    }
    let job = request.job_id.clone();
    let probe = ffprobe(&src).await?;
    let streams = parse_streams(&probe);
    let vidx = streams.video.ok_or("El archivo no tiene video")?;
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let ranges = clean_ranges(&request.keep, duration);
    if ranges.is_empty() {
        return Err("No queda ninguna parte del video para guardar".into());
    }
    let total: f64 = ranges.iter().map(|(a, b)| b - a).sum();
    let whole = ranges.len() == 1 && ranges[0].0 < 0.05 && (duration - ranges[0].1).abs() < 0.05;

    let src_ext = ext_of(&src);
    // Precise mode re-encodes to H.264/H.265 + AAC: WebM can't hold those.
    let out_ext = if request.precise && src_ext == "webm" { "mp4".to_string() } else { src_ext.clone() };
    let cover_ok = matches!(out_ext.as_str(), "mp4" | "m4v" | "mov" | "mkv");

    let dir = work_dir(&app)?.join(format!("job-{}", job.replace(|c: char| !c.is_ascii_alphanumeric(), "_")));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let parent = src.parent().ok_or("Carpeta inválida")?.to_path_buf();
    let tmp_out = parent.join(format!(".streamline-edit-{job}.{out_ext}"));

    let title = request.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    // New cover, or keep the one the file already had.
    let cover = match (request.cover_path.as_deref().filter(|c| !c.is_empty()), streams.cover) {
        (Some(c), _) => Some(PathBuf::from(c)),
        (None, Some(idx)) => {
            let out = dir.join("old-cover.jpg");
            let mut cmd = command("ffmpeg");
            cmd.args(["-y", "-v", "error", "-i"])
                .arg(&src)
                .args(["-map", &format!("0:{idx}"), "-frames:v", "1"])
                .arg(&out);
            run(cmd, 60).await.ok().map(|_| out)
        }
        (None, None) => None,
    }
    .filter(|c| c.is_file() && cover_ok);

    let result: Result<(), String> = async {
        if request.precise {
            // --- Re-encode: frame-accurate cuts, same resolution and fps.
            let vcodec = probe["streams"]
                .as_array()
                .and_then(|a| a.iter().find(|s| s["index"].as_u64() == Some(vidx as u64)))
                .and_then(|s| s["codec_name"].as_str())
                .unwrap_or("h264")
                .to_string();
            let audio = streams.audio.first().copied();
            let mut filter = String::new();
            let n = ranges.len();
            for (i, (a, b)) in ranges.iter().enumerate() {
                filter.push_str(&format!("[0:{vidx}]trim=start={a:.3}:end={b:.3},setpts=PTS-STARTPTS[v{i}];"));
                if let Some(ai) = audio {
                    filter.push_str(&format!("[0:{ai}]atrim=start={a:.3}:end={b:.3},asetpts=PTS-STARTPTS[a{i}];"));
                }
            }
            for i in 0..n {
                filter.push_str(&format!("[v{i}]"));
                if audio.is_some() {
                    filter.push_str(&format!("[a{i}]"));
                }
            }
            filter.push_str(&format!("concat=n={n}:v=1:a={}[v]", if audio.is_some() { 1 } else { 0 }));
            if audio.is_some() {
                filter.push_str("[a]");
            }

            let mut cmd = command("ffmpeg");
            cmd.args(["-y", "-v", "error", "-i"]).arg(&src);
            if let Some(c) = &cover {
                cmd.arg("-i").arg(c);
            }
            cmd.args(["-filter_complex", &filter, "-map", "[v]"]);
            if audio.is_some() {
                cmd.args(["-map", "[a]", "-c:a", "aac", "-b:a", "256k"]);
            }
            if vcodec == "hevc" {
                cmd.args(["-c:v:0", "libx265", "-crf", "18", "-preset", "medium", "-tag:v:0", "hvc1"]);
            } else {
                cmd.args(["-c:v:0", "libx264", "-crf", "16", "-preset", "medium"]);
            }
            add_cover_and_title(&mut cmd, cover.as_deref(), title, &out_ext, 1);
            cmd.arg(&tmp_out);
            run_with_progress(&app, &job, cmd, total, 0.0, 1.0, "Recodificando").await
        } else if whole {
            // --- Only title/cover changed: copy everything once.
            let mut cmd = command("ffmpeg");
            cmd.args(["-y", "-v", "error", "-i"]).arg(&src);
            if let Some(c) = &cover {
                cmd.arg("-i").arg(c);
            }
            map_main_streams(&mut cmd, &streams, "0");
            cmd.args(["-c", "copy"]);
            add_cover_and_title(&mut cmd, cover.as_deref(), title, &out_ext, 1);
            cmd.arg(&tmp_out);
            run_with_progress(&app, &job, cmd, total, 0.0, 1.0, "Guardando").await
        } else {
            // --- Lossless: copy each part, then join them without re-encoding.
            let mut list = String::new();
            let mut done = 0.0;
            for (i, (a, b)) in ranges.iter().enumerate() {
                let seg = dir.join(format!("part-{i}.{src_ext}"));
                let mut cmd = command("ffmpeg");
                cmd.args(["-y", "-v", "error", "-ss", &format!("{a:.3}"), "-i"])
                    .arg(&src)
                    .args(["-t", &format!("{:.3}", b - a)]);
                map_main_streams(&mut cmd, &streams, "0");
                cmd.args(["-c", "copy", "-avoid_negative_ts", "make_zero"]).arg(&seg);
                let share = 0.85 * (b - a) / total;
                run_with_progress(&app, &job, cmd, b - a, done, share, "Cortando").await?;
                done += share;
                list.push_str(&concat_line(&seg));
            }
            let list_file = dir.join("parts.txt");
            std::fs::write(&list_file, list).map_err(|e| e.to_string())?;

            let mut cmd = command("ffmpeg");
            cmd.args(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i"]).arg(&list_file);
            if let Some(c) = &cover {
                cmd.arg("-i").arg(c);
            }
            cmd.args(["-map", "0", "-c", "copy"]);
            add_cover_and_title(&mut cmd, cover.as_deref(), title, &out_ext, 1);
            cmd.arg(&tmp_out);
            run_with_progress(&app, &job, cmd, total, done, 1.0 - done, "Uniendo").await
        }
    }
    .await;

    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp_out);
        return Err(e);
    }

    // Move the result to its final place.
    let final_path = if request.save_as == "original" {
        let target = src.with_extension(&out_ext);
        std::fs::rename(&tmp_out, &target).map_err(|e| format!("No se pudo reemplazar el original: {e}"))?;
        if target != src {
            let _ = std::fs::remove_file(&src);
        }
        target
    } else {
        let stem = title
            .map(sanitize_file_name)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                src.file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "video".into())
            });
        let target = unique_path(&parent, &format!("{stem} (editado)"), &out_ext);
        std::fs::rename(&tmp_out, &target).map_err(|e| format!("No se pudo guardar la copia: {e}"))?;
        target
    };
    emit(&app, &job, 1.0, "Listo");
    Ok(final_path.to_string_lossy().into_owned())
}

/// Main video + audio + subtitles (the old cover is handled separately).
fn map_main_streams(cmd: &mut tokio::process::Command, s: &Streams, input: &str) {
    if let Some(v) = s.video {
        cmd.args(["-map", &format!("{input}:{v}")]);
    }
    for a in &s.audio {
        cmd.args(["-map", &format!("{input}:{a}")]);
    }
    for t in &s.subtitles {
        cmd.args(["-map", &format!("{input}:{t}?")]);
    }
}

/// Adds the cover (input #1) and the title. `video_streams` is how many video
/// streams are already mapped (the cover becomes the next one).
fn add_cover_and_title(
    cmd: &mut tokio::process::Command,
    cover: Option<&Path>,
    title: Option<&str>,
    ext: &str,
    video_streams: usize,
) {
    if let Some(c) = cover {
        if ext == "mkv" {
            // Matroska stores covers as attachments, not video streams.
            cmd.arg("-attach").arg(c).args([
                "-metadata:s:t:0",
                "mimetype=image/jpeg",
                "-metadata:s:t:0",
                "filename=cover.jpg",
            ]);
        } else {
            cmd.args([
                "-map",
                "1:v:0",
                &format!("-c:v:{video_streams}"),
                "mjpeg",
                &format!("-disposition:v:{video_streams}"),
                "attached_pic",
            ]);
        }
    }
    if let Some(t) = title {
        cmd.arg("-metadata").arg(format!("title={t}"));
    }
    if matches!(ext, "mp4" | "m4v" | "mov") {
        cmd.args(["-movflags", "+faststart"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_sorted_merged_and_clamped() {
        let r = clean_ranges(&[[50.0, 70.0], [-3.0, 10.0], [8.0, 20.0], [90.0, 200.0], [30.0, 30.01]], 100.0);
        assert_eq!(r, vec![(0.0, 20.0), (50.0, 70.0), (90.0, 100.0)]);
    }

    #[test]
    fn copy_names_never_collide() {
        let dir = std::env::temp_dir().join(format!("sl-editor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "Video (editado)", "mp4");
        std::fs::write(&a, b"x").unwrap();
        let b = unique_path(&dir, "Video (editado)", "mp4");
        assert_ne!(a, b);
        assert!(b.to_string_lossy().ends_with("Video (editado) (2).mp4"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concat_lines_escape_quotes() {
        assert_eq!(concat_line(Path::new("/tmp/it's.mp4")), "file '/tmp/it'\\''s.mp4'\n");
    }

    #[test]
    fn parses_rates() {
        assert_eq!(parse_rate("60/1"), Some(60.0));
        assert!((parse_rate("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_rate("0/0"), None);
    }
}
