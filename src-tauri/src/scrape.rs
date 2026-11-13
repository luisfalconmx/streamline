//! Web-page scraping: reads the HTML of the page the user pasted to find the
//! video title, its poster and every quality the player offers.
//!
//! Players often load only one resolution but list the others in their quality
//! menu. Those lists live in the HTML itself: `<source>` tags with a label, the
//! player configuration inside `<script>` (JW Player, Plyr, Video.js, KVS…) or
//! an HLS/DASH manifest that contains every variant.

use regex::Regex;
use scraper::{Html, Selector};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/// Pages bigger than this are cut (the player config is near the top anyway).
const MAX_HTML: usize = 6 * 1024 * 1024;
const MAX_SOURCES: usize = 24;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageSource {
    pub url: String,
    /// Vertical resolution (1080 for 1080p) when the page says it.
    pub quality: Option<u32>,
    /// HLS/DASH manifest: yt-dlp lists every variant inside it.
    pub manifest: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// URL after redirects (used as Referer for the video files).
    pub url: String,
    pub title: Option<String>,
    /// Cover image as a small JPEG `data:` URL (or its URL when it could not
    /// be converted), ready to show without hotlink problems.
    pub image: Option<String>,
    /// Every cover candidate found, best first.
    #[serde(skip)]
    pub images: Vec<String>,
    pub sources: Vec<PageSource>,
}

/// Downloads the page and extracts title, poster and video sources. Pages that
/// are not HTML (e.g. a direct `.mp4` link) return an empty result.
#[tauri::command]
pub async fn scrape_page(url: String) -> Result<PageInfo, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("El enlace debe empezar con http:// o https://".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .header(reqwest::header::ACCEPT_LANGUAGE, "es-MX,es;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("No se pudo abrir la página: {e}"))?;

    let final_url = res.url().to_string();
    let is_html = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|ct| ct.contains("html") || ct.contains("xml") || ct.starts_with("text/"));
    if !res.status().is_success() || !is_html {
        return Ok(PageInfo { url: final_url, ..Default::default() });
    }

    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_HTML {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);
    let mut info = parse_page(&html, &final_url);
    info.image = fetch_cover(&client, &info.images, &final_url).await;
    Ok(info)
}

/// Downloads the first cover candidate that is a real image, sending the page
/// as Referer (many CDNs refuse images hotlinked from elsewhere) and shrinks it
/// to a 640px JPEG with ffmpeg so it can be stored in the history.
async fn fetch_cover(client: &reqwest::Client, candidates: &[String], page: &str) -> Option<String> {
    use base64::Engine as _;
    for url in candidates.iter().take(5) {
        let Ok(Ok(res)) = tokio::time::timeout(
            Duration::from_secs(12),
            client
                .get(url)
                .header(reqwest::header::REFERER, page)
                .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8")
                .send(),
        )
        .await
        else {
            continue;
        };
        let ct = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !res.status().is_success() || !(ct.starts_with("image/") || ct.is_empty() || ct.contains("octet-stream")) {
            continue;
        }
        if res.content_length().is_some_and(|n| n > MAX_IMAGE as u64) {
            return Some(url.clone());
        }
        let Ok(Ok(bytes)) = tokio::time::timeout(Duration::from_secs(15), res.bytes()).await else { continue };
        if bytes.len() < 200 || bytes.len() > MAX_IMAGE {
            continue; // tracking pixels and placeholders
        }
        if let Some(jpeg) = shrink_image(&bytes).await {
            return Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)));
        }
        // ffmpeg could not read it (e.g. SVG): small files go as they are.
        if ct.starts_with("image/") && bytes.len() <= 300 * 1024 {
            return Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
        }
        return Some(url.clone());
    }
    candidates.first().cloned()
}

const MAX_IMAGE: usize = 15 * 1024 * 1024;

/// Any image ffmpeg reads (JPEG, PNG, WebP, GIF…) → JPEG at most 640px wide.
async fn shrink_image(bytes: &[u8]) -> Option<Vec<u8>> {
    use tokio::io::AsyncWriteExt as _;
    let mut cmd = crate::ytdlp::command("ffmpeg");
    cmd.stdin(std::process::Stdio::piped()).args([
        "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
        "-vf", "scale='min(640,iw)':-2", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ]);
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = bytes.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&data).await;
        drop(stdin);
    });
    let out = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await.ok()?.ok()?;
    let _ = writer.await;
    (out.status.success() && out.stdout.len() > 100).then_some(out.stdout)
}

static QUALITY_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^0-9a-z])(4320|2160|1440|1080|720|576|540|480|360|240|144)(?:p|[^0-9]|$)").unwrap());
static QUALITY_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(8k|4k|uhd|2k|qhd|fhd|full ?hd|hd|sd)\b").unwrap());
/// Absolute media URLs anywhere in the page (scripts, JSON, attributes).
static MEDIA_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)https?://[^\s"'<>()\\]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8|mpd)(?:/?\?[^\s"'<>\\]*|/)?(?:[\s"'<>\\]|$)"#).unwrap()
});
/// `label: "720p"`, `"res":1080`, `size: 720`, `quality: 'HD'`, `video_alt_url_text: '1080p'`…
static CONTEXT_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:label|res|resolution|size|quality|height|_text|name|title|data-quality)["']?\s*[:=]\s*["']?([^"',}\]]{1,24})"#).unwrap()
});

/// Vertical resolution from labels like "1080p", "4K", "HD" or "video_720p.mp4".
pub fn quality_of(text: &str) -> Option<u32> {
    if let Some(c) = QUALITY_LABEL.captures(text) {
        return c[1].parse().ok();
    }
    let w = QUALITY_WORD.captures(text)?[1].to_ascii_lowercase().replace(' ', "");
    Some(match w.as_str() {
        "8k" => 4320,
        "4k" | "uhd" => 2160,
        "2k" | "qhd" => 1440,
        "fhd" | "fullhd" => 1080,
        "hd" => 720,
        "sd" => 480,
        _ => return None,
    })
}

fn quality_of_url(url: &str) -> Option<u32> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let file = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path);
    // Only the file name: CDN paths are full of numbers (ids, dates…).
    QUALITY_LABEL.captures(file).and_then(|c| c[1].parse().ok())
}

fn is_manifest(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/').to_ascii_lowercase();
    path.ends_with(".m3u8") || path.ends_with(".mpd")
}

fn is_media(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/').to_ascii_lowercase();
    [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".m3u8", ".mpd", ".ogv", ".flv"]
        .iter()
        .any(|e| path.ends_with(e))
}

/// Clips that are not the video itself (hover previews, thumbnails, ads).
fn looks_like_preview(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    ["preview", "thumb", "sprite", "trailer", "teaser", "/ads/", "advert", "vast"].iter().any(|w| u.contains(w))
}

fn clean_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Undoes the escaping used when URLs live inside JSON or JS strings.
fn unescape_js(s: &str) -> String {
    s.replace("\\/", "/")
        .replace("\\u002F", "/")
        .replace("\\u002f", "/")
        .replace("\\u0026", "&")
        .replace("&amp;", "&")
}

fn resolve(base: &reqwest::Url, raw: &str) -> Option<String> {
    let raw = raw.trim();
    // KVS players prefix their URLs with `function/0/`.
    let raw = raw.strip_prefix("function/0/").unwrap_or(raw);
    if raw.is_empty() || raw.starts_with("blob:") || raw.starts_with("data:") {
        return None;
    }
    let u = base.join(raw).ok()?;
    matches!(u.scheme(), "http" | "https").then(|| u.to_string())
}

pub fn parse_page(html: &str, page_url: &str) -> PageInfo {
    let doc = Html::parse_document(html);
    let sel = |s: &str| Selector::parse(s).unwrap();
    let page = reqwest::Url::parse(page_url).unwrap_or_else(|_| reqwest::Url::parse("https://localhost/").unwrap());
    let base = doc
        .select(&sel("base[href]"))
        .next()
        .and_then(|b| page.join(b.value().attr("href")?).ok())
        .unwrap_or_else(|| page.clone());

    // Every <meta> as (lowercase key, content): sites mix property/name/itemprop
    // and upper/lower case ("OG:IMAGE", "twitter:image:src"…).
    let metas: Vec<(String, String)> = doc
        .select(&sel("meta[content]"))
        .filter_map(|m| {
            let v = m.value();
            let key = v.attr("property").or_else(|| v.attr("name")).or_else(|| v.attr("itemprop"))?;
            let content = clean_text(v.attr("content")?);
            (!content.is_empty()).then(|| (key.trim().to_ascii_lowercase(), content))
        })
        .collect();
    let meta = |names: &[&str]| -> Option<String> {
        names
            .iter()
            .find_map(|n| metas.iter().find(|(k, _)| k == &n.to_ascii_lowercase()).map(|(_, c)| c.clone()))
    };

    // og:title is usually the clean video title; <title> often adds " - Site".
    let title = meta(&["og:title", "twitter:title"])
        .or_else(|| doc.select(&sel("title")).next().map(|t| clean_text(&t.text().collect::<String>())))
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(200).collect());

    // Cover candidates, best first.
    let mut images: Vec<String> = Vec::new();
    let add_image = |raw: &str, images: &mut Vec<String>| {
        if let Some(u) = resolve(&base, raw).filter(|u| !looks_like_bad_image(u)) {
            if !images.contains(&u) {
                images.push(u);
            }
        }
    };
    for key in ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src", "thumbnailurl", "image"] {
        for (k, c) in &metas {
            if k == key {
                add_image(c, &mut images);
            }
        }
    }
    for link in doc.select(&sel(r#"link[rel~="image_src"][href], link[itemprop="thumbnailUrl"][href], link[itemprop="image"][href]"#)) {
        add_image(link.value().attr("href").unwrap_or(""), &mut images);
    }
    let ld_json = sel(r#"script[type="application/ld+json"]"#);
    for script in doc.select(&ld_json) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&script.text().collect::<String>()) {
            for u in json_ld_images(&json) {
                add_image(&u, &mut images);
            }
        }
    }

    let mut found: Vec<PageSource> = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |url: String, quality: Option<u32>| {
        let key = url.split('#').next().unwrap_or(&url).to_string();
        if !is_media(&url) && !url.contains("/get_file/") {
            return;
        }
        if seen.insert(key) {
            let manifest = is_manifest(&url);
            found.push(PageSource { quality: quality.or_else(|| quality_of_url(&url)), url, manifest });
        } else if let Some(q) = quality {
            // Same file seen again with a label: keep the label.
            if let Some(s) = found.iter_mut().find(|s| s.url == url && s.quality.is_none()) {
                s.quality = Some(q);
            }
        }
    };

    // 1. <video> and its <source> children (one player = one video).
    let source_sel = sel("source[src]");
    for video in doc.select(&sel("video")) {
        for attr in ["poster", "data-poster"] {
            if let Some(p) = video.value().attr(attr) {
                add_image(p, &mut images);
            }
        }
        let own = video.value().attr("src").into_iter().map(|s| (s, video));
        let children = video.select(&source_sel).map(|s| (s.value().attr("src").unwrap_or(""), s));
        for (src, el) in own.chain(children) {
            let Some(url) = resolve(&base, src) else { continue };
            let label = ["label", "res", "size", "data-quality", "data-res", "data-label", "title", "height"]
                .iter()
                .filter_map(|a| el.value().attr(a))
                .collect::<Vec<_>>()
                .join(" ");
            push(url, quality_of(&label));
        }
    }

    // 2. Open Graph / Schema.org video.
    for key in ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream", "contentUrl"] {
        if let Some(url) = meta(&[key]).and_then(|v| resolve(&base, &v)) {
            push(url, None);
        }
    }
    for link in doc.select(&sel("link[itemprop=contentUrl][href]")) {
        if let Some(url) = link.value().attr("href").and_then(|h| resolve(&base, h)) {
            push(url, None);
        }
    }

    // 3. Player configs and JSON inside scripts (and anywhere else in the page).
    let text = unescape_js(html);
    for m in MEDIA_URL.find_iter(&text) {
        let raw = m.as_str().trim_end_matches(|c: char| c.is_whitespace() || "\"'<>\\".contains(c));
        let Some(url) = resolve(&base, raw) else { continue };
        let quality = quality_of_url(&url).or_else(|| context_quality(&text, m.start(), m.end()));
        push(url, quality);
    }
    // KVS: `video_url: 'function/0/https://…/123.mp4/'`, `video_alt_url_text: '720p'`.
    static KVS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(video(?:_alt)?_url\d*)\s*:\s*'([^']+)'"#).unwrap()
    });
    for c in KVS.captures_iter(&text) {
        let key = &c[1];
        let Some(url) = resolve(&base, &c[2]) else { continue };
        let label = Regex::new(&format!(r#"{key}_text\s*:\s*'([^']+)'"#))
            .ok()
            .and_then(|r| r.captures(&text).map(|t| t[1].to_string()));
        push(url, label.as_deref().and_then(quality_of));
    }

    // 4. Plain links to media files.
    for a in doc.select(&sel("a[href]")) {
        let Some(url) = a.value().attr("href").and_then(|h| resolve(&base, h)) else { continue };
        if is_media(&url) {
            let q = quality_of(&a.text().collect::<String>());
            push(url, q);
        }
    }

    // Posters inside player configs: `image: "…jpg"`, `poster_url: '…'`.
    static PLAYER_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)["']?(?:poster|poster_url|image|thumbnail|thumbnail_url|thumb|preview_url|splash|cover)["']?\s*[:=]\s*["']([^"'\s]+?\.(?:jpe?g|png|webp|avif|gif)(?:\?[^"'\s]*)?)["']"#).unwrap()
    });
    for c in PLAYER_IMAGE.captures_iter(&text) {
        add_image(&c[1], &mut images);
    }

    PageInfo { url: page_url.to_string(), title, image: images.first().cloned(), images, sources: pick_sources(found) }
}

/// Logos, icons, sprites and tracking pixels are not covers.
fn looks_like_bad_image(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    let path = u.split(['?', '#']).next().unwrap_or(&u);
    path.ends_with(".svg")
        || path.ends_with(".ico")
        || ["favicon", "apple-touch-icon", "/logo", "logo.", "_logo", "-logo", "sprite", "pixel", "1x1", "blank."]
            .iter()
            .any(|w| path.contains(w))
}

/// Image URLs in Schema.org JSON-LD: `thumbnailUrl`, `thumbnail` or `image`,
/// each a string, a list or an `ImageObject`. VideoObjects come first.
fn json_ld_images(json: &serde_json::Value) -> Vec<String> {
    use serde_json::Value;
    fn urls(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| urls(x, out)),
            Value::Object(o) => {
                for k in ["url", "contentUrl"] {
                    if let Some(Value::String(s)) = o.get(k) {
                        out.push(s.clone());
                    }
                }
            }
            _ => {}
        }
    }
    fn walk(v: &Value, video: &mut Vec<String>, other: &mut Vec<String>, depth: usize) {
        if depth > 8 {
            return;
        }
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, video, other, depth + 1)),
            Value::Object(o) => {
                let is_video = match o.get("@type") {
                    Some(Value::String(t)) => t.eq_ignore_ascii_case("VideoObject"),
                    Some(Value::Array(ts)) => ts.iter().any(|t| t.as_str().is_some_and(|t| t.eq_ignore_ascii_case("VideoObject"))),
                    _ => false,
                };
                let target = if is_video { &mut *video } else { &mut *other };
                for k in ["thumbnailUrl", "thumbnail", "image"] {
                    if let Some(x) = o.get(k) {
                        urls(x, target);
                    }
                }
                for (k, x) in o {
                    if matches!(x, Value::Object(_) | Value::Array(_)) && !matches!(k.as_str(), "thumbnail" | "image") {
                        walk(x, video, other, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }
    let (mut video, mut other) = (Vec::new(), Vec::new());
    walk(json, &mut video, &mut other, 0);
    video.extend(other);
    video
}

/// Quality label written next to a URL inside a player config, e.g.
/// `{file: "…/a.mp4", label: "720p"}` or `{size: 1080, src: "…"}`.
fn context_quality(text: &str, start: usize, end: usize) -> Option<u32> {
    let floor = |mut i: usize| {
        while !text.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let from = floor(start.saturating_sub(160));
    let to = floor((end + 160).min(text.len()));
    let window = &text[from..to];
    let url_pos = start - from;
    // The label belongs to the same object: stop at the neighbours' URLs and
    // at the braces of the `{…}` that holds this one.
    let before = &window[..url_pos];
    let left = [before.rfind("http").map(|i| i + 4), before.rfind('{').map(|i| i + 1)]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(0);
    let url_end = url_pos + (end - start).min(window.len() - url_pos);
    let after = &window[url_end..];
    let right = [after.find("http"), after.find('}')]
        .into_iter()
        .flatten()
        .min()
        .map_or(window.len(), |i| url_end + i);
    let scope = &window[left.min(right)..right.max(left)];
    CONTEXT_LABEL
        .captures_iter(scope)
        .filter_map(|c| quality_of(&c[1]))
        .next()
}

/// One entry per quality of the main video: labelled files first (highest
/// first), then manifests, then unlabelled files. Previews are dropped when
/// there is anything better.
fn pick_sources(found: Vec<PageSource>) -> Vec<PageSource> {
    let real: Vec<_> = found.iter().filter(|s| !looks_like_preview(&s.url)).cloned().collect();
    let list = if real.is_empty() { found } else { real };

    let mut out: Vec<PageSource> = Vec::new();
    let mut labelled: Vec<_> = list.iter().filter(|s| s.quality.is_some() && !s.manifest).cloned().collect();
    labelled.sort_by_key(|s| std::cmp::Reverse(s.quality));
    for s in labelled {
        if !out.iter().any(|o| o.quality == s.quality) {
            out.push(s);
        }
    }
    out.extend(list.iter().filter(|s| s.manifest).cloned());
    if out.is_empty() {
        out.extend(list.into_iter().filter(|s| !s.manifest).take(1));
    }
    out.truncate(MAX_SOURCES);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_title_poster_and_source_labels() {
        let html = r#"<html><head><title>Mi video - Sitio</title>
            <meta property="og:title" content="Mi video">
            </head><body>
            <video poster="/p.jpg">
              <source src="/v/clip_1080.mp4" label="1080p">
              <source src="/v/clip_b.mp4" res="720">
              <source src="/v/clip_c.mp4" label="SD">
            </video></body></html>"#;
        let p = parse_page(html, "https://example.com/watch/1");
        assert_eq!(p.title.as_deref(), Some("Mi video"));
        assert_eq!(p.image.as_deref(), Some("https://example.com/p.jpg"));
        let q: Vec<_> = p.sources.iter().map(|s| (s.url.as_str(), s.quality)).collect();
        assert_eq!(
            q,
            vec![
                ("https://example.com/v/clip_1080.mp4", Some(1080)),
                ("https://example.com/v/clip_b.mp4", Some(720)),
                ("https://example.com/v/clip_c.mp4", Some(480)),
            ]
        );
    }

    #[test]
    fn finds_qualities_inside_player_config() {
        let html = r#"<title>Otro</title><script>
            jwplayer("p").setup({sources: [
              {"file": "https:\/\/cdn.x.com\/a\/v.mp4?t=1", "label": "720p"},
              {"file": "https:\/\/cdn.x.com\/a\/w.mp4?t=1", "label": "1080p HD"},
              {"file": "https:\/\/cdn.x.com\/a\/z.mp4?t=1", "label": "360p"}
            ]});
            var preview = "https://cdn.x.com/preview/hover.mp4";
            </script>"#;
        let p = parse_page(html, "https://x.com/v/9");
        assert_eq!(p.title.as_deref(), Some("Otro"));
        let q: Vec<_> = p.sources.iter().map(|s| s.quality).collect();
        assert_eq!(q, vec![Some(1080), Some(720), Some(360)]);
        assert!(p.sources[0].url.ends_with("w.mp4?t=1"), "{:?}", p.sources);
    }

    #[test]
    fn kvs_player_urls_and_labels() {
        let html = r#"<script>var flashvars = {
            video_url: 'function/0/https://s.com/get_file/1/abc/3114/3114.mp4/', video_url_text: '480p',
            video_alt_url: 'function/0/https://s.com/get_file/1/def/3114/3114_720p.mp4/', video_alt_url_text: '720p',
            video_alt_url2: 'function/0/https://s.com/get_file/1/ghi/3114/3114_1080p.mp4/', video_alt_url2_text: '1080p HD'
        };</script>"#;
        let p = parse_page(html, "https://s.com/videos/3114/x/");
        let q: Vec<_> = p.sources.iter().map(|s| s.quality).collect();
        assert_eq!(q, vec![Some(1080), Some(720), Some(480)]);
        assert!(p.sources[2].url.starts_with("https://s.com/get_file/1/abc/"));
    }

    #[test]
    fn keeps_hls_manifest() {
        let html = r#"<meta property="og:title" content="Stream"><script>
            player.src({src: "https://cdn.y.com/hls/master.m3u8", type: "application/x-mpegURL"});
            </script>"#;
        let p = parse_page(html, "https://y.com/v");
        assert_eq!(p.sources.len(), 1);
        assert!(p.sources[0].manifest);
    }

    #[test]
    fn cover_from_varied_meta_and_json_ld() {
        let html = r#"<head>
            <META PROPERTY="OG:IMAGE" CONTENT="//cdn.z.com/cover.jpg?w=1280">
            <link rel="icon" href="/favicon.png">
            <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
              {"@type":"Organization","logo":"https://z.com/logo.png"},
              {"@type":"VideoObject","name":"V","thumbnailUrl":["https://z.com/t1.jpg","https://z.com/t2.jpg"]}
            ]}</script></head>"#;
        let p = parse_page(html, "https://z.com/v/1");
        assert_eq!(
            p.images,
            vec!["https://cdn.z.com/cover.jpg?w=1280", "https://z.com/t1.jpg", "https://z.com/t2.jpg"]
        );
    }

    #[test]
    fn cover_from_json_ld_image_object_and_player() {
        let html = r#"<script type="application/ld+json">{"@type":"VideoObject","thumbnail":{"@type":"ImageObject","url":"/th.webp"}}</script>
            <video data-poster="/poster.png"></video>
            <script>jwplayer("p").setup({file: "a.mp4", image: "https:\/\/img.z.com\/big.jpg"});</script>"#;
        let p = parse_page(html, "https://z.com/v/2");
        assert_eq!(p.images, vec!["https://z.com/th.webp", "https://z.com/poster.png", "https://img.z.com/big.jpg"]);
    }

    #[test]
    fn skips_logos_and_icons() {
        let html = r#"<meta property="og:image" content="https://z.com/static/logo.svg">
            <meta name="twitter:image:src" content="https://z.com/real.jpg">"#;
        let p = parse_page(html, "https://z.com/");
        assert_eq!(p.images, vec!["https://z.com/real.jpg"]);
    }

    #[test]
    fn quality_words() {
        assert_eq!(quality_of("4K"), Some(2160));
        assert_eq!(quality_of("Full HD"), Some(1080));
        assert_eq!(quality_of("720p60"), Some(720));
        assert_eq!(quality_of("hello"), None);
    }
}
