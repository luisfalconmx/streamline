# Streamline development image: Rust + Node + pnpm + Tauri (WebKitGTK) deps,
# plus a virtual display (Xvfb + noVNC) so the desktop app can run inside
# Docker Desktop and be viewed from the browser.
FROM rust:1-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CARGO_TERM_COLOR=always \
    # AppImage tooling cannot use FUSE inside containers.
    APPIMAGE_EXTRACT_AND_RUN=1 \
    # WebKitGTK without GPU.
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NO_AT_BRIDGE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
      build-essential pkg-config curl wget file unzip xz-utils patchelf rpm ca-certificates git \
      xvfb x11vnc fluxbox novnc websockify dbus-x11 xdg-utils \
      fonts-dejavu fonts-noto-color-emoji fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24 LTS + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12

WORKDIR /app
COPY docker/entrypoint.sh /usr/local/bin/streamline-entrypoint
RUN chmod +x /usr/local/bin/streamline-entrypoint

EXPOSE 1420 6080
ENTRYPOINT ["streamline-entrypoint"]
CMD ["desktop"]
