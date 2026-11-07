<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Streamline" />
</p>

<h1 align="center">Streamline</h1>

<p align="center">
  Descarga videos y audio de YouTube y más de 1.800 sitios. Sin límites de velocidad y sin anuncios.<br/>
  App de escritorio para <b>macOS</b>, <b>Windows</b> y <b>Linux</b>, impulsada por <a href="https://github.com/yt-dlp/yt-dlp">yt-dlp</a>.
</p>

---

## ✨ Funciones

- **Pega y descarga**: pega un enlace (o cópialo y vuelve a la app, se detecta solo) y elige la calidad.
- **Toda la información antes de descargar**: título, canal, duración, vistas, fecha, miniatura y el **peso estimado** de cada calidad.
- **Todas las resoluciones**: de 144p a 8K, con FPS altos (60 fps) y HDR cuando existen. Contenedor MP4, MKV o WebM.
- **Solo audio**: MP3, M4A, Opus, FLAC o WAV, con carátula y metadatos.
- **Velocidad máxima**: hasta 32 fragmentos en paralelo (`--concurrent-fragments`), re-extracción automática ante throttling y sin límite de ancho de banda.
- **Cola de descargas**: varias descargas simultáneas, con progreso, velocidad y tiempo restante; cancelar, reintentar, abrir el archivo o mostrarlo en la carpeta.
- **Playlists**: elige qué videos descargar y en qué calidad.
- **Extras**: subtítulos incrustados, capítulos, SponsorBlock y cookies del navegador para videos privados o con restricción de edad.
- **Enlaces directos**: para archivos sueltos (`.mp4` de un CDN) genera la miniatura y lee duración, resolución y FPS con ffmpeg.
- **Nombres sin choques**: cada archivo lleva un hash corto (`video [a1b2c3d4].mp4`), así que dos videos con el mismo título nunca se sobrescriben.
- **Editor de video**: elimina partes con cortes múltiples, cambia el título y la portada (captura un fotograma a resolución completa) y guarda como copia o sobre el original. Los cortes son **sin pérdida**: no recodifican, así que un 4K sigue siendo exactamente el mismo 4K. Opcionalmente, corte exacto al fotograma recodificando en alta calidad.
- **YouTube con tu sesión**: si YouTube pide confirmar que no eres un robot, un clic usa tu sesión de Brave o Chrome (todas las calidades) o sigue sin sesión hasta 360p.
- **Extensión de navegador** para Chrome, Brave y Edge (ver abajo).
- **Tema claro y oscuro**, interfaz en español.

## 🧩 Extensión para Chrome, Brave y Edge

La extensión detecta los videos de la página que estás viendo: reproductores `<video>`, enlaces a archivos `.mp4`/`.webm` y streams HLS/DASH. Agrupa todas las calidades del mismo video en **una sola tarjeta** (por ejemplo "4 calidades · hasta 4K"). El botón **Descargar en la app** envía todas las fuentes a Streamline, que muestra una opción por resolución (2160p60, 1080p, 720p…) para que elijas cuál descargar. El archivo se nombra `<Título de la página>-1080p [hash].mp4`.

**Instalación:** la app incluye la extensión. La primera vez que abres Streamline aparece un asistente:

1. Elige **Google Chrome** o **Brave**. La app copia la extensión a su carpeta de datos (`~/Library/Application Support/com.luisfalconmx.streamline/extension` en macOS, `%APPDATA%\com.luisfalconmx.streamline\extension` en Windows). En macOS además crea el acceso directo `~/Streamline Extension`.
2. Pulsa **Abrir extensiones de…**. Streamline se queda como panel flotante con los pasos: activar *Modo de desarrollador*, *Cargar descomprimida* y elegir la carpeta (en macOS: ⌘⇧H → *Streamline Extension*).
3. Al cargarla, el navegador pregunta *¿Abrir Streamline?*: marca **Permitir siempre**. La extensión avisa a la app y el asistente termina solo.

Si cierras el asistente, un aviso arriba de la app te recuerda instalarla hasta que se detecte. También está en **Ajustes → Extensión del navegador**. Chrome y Brave no permiten instalar extensiones de fuera de su tienda sin esa confirmación del usuario.

## 📦 Instalación

Descarga el instalador de tu sistema desde la página de **[Releases](https://github.com/luisfalconmx/streamline/releases)**:

| Sistema | Archivo |
| --- | --- |
| macOS (Apple Silicon) | `Streamline_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Streamline_x.y.z_x64.dmg` |
| Windows | `Streamline_x.y.z_x64-setup.exe` o `.msi` |
| Linux | `.AppImage`, `.deb` o `.rpm` |

> **macOS**: la app no está firmada con un certificado de desarrollador de Apple. Si al abrirla aparece «está dañada», ejecuta una vez:
> ```bash
> xattr -cr /Applications/Streamline.app
> ```

Los instaladores ya incluyen **yt-dlp**, **ffmpeg/ffprobe** y **deno** (yt-dlp necesita un runtime de JavaScript para tener soporte completo de YouTube), así que no hay que instalar nada más.

## 🧱 Stack

| Capa | Tecnología |
| --- | --- |
| Shell de escritorio | [Tauri 2](https://tauri.app) (Rust) |
| UI | React 19 + TypeScript + [Vite](https://vite.dev) |
| Componentes | [HeroUI v3](https://heroui.com) |
| Estilos | Tailwind CSS v4 |
| Motor de descarga | [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg + deno (sidecars) |

Se eligió **Vite** en lugar de Next.js porque Tauri sirve archivos estáticos: no hay servidor, SSR ni rutas de API que aprovechar, y Vite da un HMR más rápido y una configuración más simple.

```
streamline/
├── src/                     # Frontend React
│   ├── components/          # Vistas y componentes de UI (HeroUI)
│   ├── lib/                 # Puente con Tauri, formatos y calidades, mock para navegador
│   └── store.tsx            # Estado global: ajustes, cola de descargas e historial
├── src-tauri/               # Backend Rust
│   ├── src/ytdlp.rs         # Ejecuta yt-dlp, parsea el progreso y emite eventos
│   ├── binaries/            # Sidecars (se descargan con `pnpm sidecars`, no se versionan)
│   └── tauri.conf.json
├── extension/               # Extensión MV3 (Chrome/Brave/Edge)
├── scripts/fetch-sidecars.mjs
├── docker/ + compose.yaml   # Entorno de desarrollo con Docker Desktop
└── .github/workflows/       # CI y release multiplataforma
```

## 🐳 Desarrollo con Docker Desktop

El entorno completo (Rust, Node, pnpm, WebKitGTK) vive en un contenedor. Solo necesitas Docker Desktop.

```bash
docker compose build
```

**UI en el navegador** (backend simulado, ideal para trabajar en la interfaz con hot reload) en http://localhost:1420:

```bash
docker compose up web
```

**App de escritorio real** (Tauri sobre un escritorio virtual con noVNC) en http://localhost:6080/vnc.html?autoconnect=1&resize=remote. Los archivos descargados aparecen en `./downloads`:

```bash
docker compose up desktop
```

**Instaladores de Linux** (`.deb`, `.rpm` y `.AppImage` para la arquitectura de tu máquina), que se copian a `./release/linux`:

```bash
docker compose run --rm build
```

## 💻 Desarrollo nativo (opcional)

Para abrir la ventana nativa en macOS o Windows necesitas [Rust](https://rustup.rs), Node 24 y pnpm:

```bash
pnpm install
```

```bash
pnpm sidecars
```

```bash
pnpm tauri dev
```

## 🚀 Publicar una versión

1. Actualiza `version` en `package.json`, `src-tauri/tauri.conf.json` y `src-tauri/Cargo.toml`.
2. Crea y sube un tag. El workflow [`release.yml`](.github/workflows/release.yml) compila **Windows y Linux** en GitHub y crea el Release:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

3. Compila los `.dmg` de **macOS** (Apple Silicon e Intel) en tu Mac y súbelos al mismo Release junto con el `.zip` de la extensión (requiere Rust y `gh`):

```bash
pnpm release:mac
```

## ⚖️ Licencias de terceros

- [yt-dlp](https://github.com/yt-dlp/yt-dlp): Unlicense.
- [FFmpeg](https://ffmpeg.org): binarios GPL de [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) (Windows/Linux) y [Martin Riedl](https://ffmpeg.martin-riedl.de) (macOS).
- [Deno](https://deno.com): MIT.

Descarga solo contenido del que tengas derechos o permiso. Respeta los términos de servicio de cada sitio.
