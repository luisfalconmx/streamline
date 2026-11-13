#!/usr/bin/env bash
# Entry point for the Streamline dev container.
#   web      → Vite dev server with a mock backend (http://localhost:1420)
#   desktop  → full Tauri app on a virtual display (http://localhost:6080)
#   build    → Linux installers (.deb, .rpm, .AppImage) copied to ./release/linux
#   shell    → interactive bash
set -euo pipefail
cd /app

ensure_deps() {
  if [ ! -f node_modules/.modules.yaml ] || [ package.json -nt node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    pnpm install --frozen-lockfile
  fi
}

case "${1:-desktop}" in
  web)
    ensure_deps
    exec env DOCKER=1 pnpm dev
    ;;
  desktop)
    ensure_deps
    node scripts/fetch-sidecars.mjs
    # Make ~/Downloads (mounted from ./downloads) the default download folder.
    mkdir -p "$HOME/Downloads" "$HOME/.config"
    echo 'XDG_DOWNLOAD_DIR="$HOME/Downloads"' > "$HOME/.config/user-dirs.dirs"
    export DISPLAY=:99
    # A restarted container keeps /tmp, and Xvfb refuses to start while the
    # previous run's lock is there (GTK then fails with "Failed to initialize").
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
    Xvfb :99 -screen 0 1280x860x24 -nolisten tcp >/dev/null 2>&1 &
    for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
    if [ ! -S /tmp/.X11-unix/X99 ]; then
      echo "No se pudo iniciar la pantalla virtual (Xvfb)." >&2
      exit 1
    fi
    fluxbox >/dev/null 2>&1 &
    x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
    websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
    echo ""
    echo "  ▶ Streamline se está compilando. Ábrelo en: http://localhost:6080/vnc.html?autoconnect=1&resize=remote"
    echo ""
    exec dbus-run-session -- env DOCKER=1 pnpm tauri dev
    ;;
  build)
    ensure_deps
    node scripts/fetch-sidecars.mjs
    pnpm tauri build --bundles deb,rpm,appimage
    mkdir -p release/linux
    find src-tauri/target/release/bundle \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp -v {} release/linux/ \;
    echo "Instaladores copiados a ./release/linux"
    ;;
  shell)
    exec bash
    ;;
  *)
    exec "$@"
    ;;
esac
