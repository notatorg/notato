# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# The shared Notato server (`notato serve`): login, project tokens, HTTP API, MCP over HTTP, board UI.
# Data lives in /data; mount a volume there. Put a TLS-terminating reverse proxy in front and run with
# NOTATO_TRUST_PROXY=1.
#
#   docker run -p 4747:4747 -v notato:/data -e NOTATO_ADMIN_PASSWORD=... ghcr.io/notatorg/notato
#
# Every image is pinned by digest, so a build uses exactly what was reviewed; the tag before it says which version
# that is. Dependabot moves the FROM images (the syntax line above is moved by hand). Bun here is the version CI uses
# (.github/workflows): move them together.

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
WORKDIR /src
# Manifests first, so dependency installs are cached until a package.json changes. Every workspace is listed
# (scripts/repo.test.ts checks), or the frozen install would not match the lockfile.
COPY package.json bun.lock ./
COPY packages/board/package.json packages/board/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/extension/package.json packages/extension/
COPY packages/schema/package.json packages/schema/
COPY packages/server/package.json packages/server/
COPY packages/vite/package.json packages/vite/
COPY sdks/angular/package.json sdks/angular/
COPY sdks/angular/example/package.json sdks/angular/example/
COPY sdks/browser/package.json sdks/browser/
COPY sdks/react/package.json sdks/react/
COPY sdks/react-native/package.json sdks/react-native/
COPY sdks/react/example/package.json sdks/react/example/
COPY services/server/package.json services/server/
COPY services/board/package.json services/board/
COPY services/cli/package.json services/cli/
COPY services/monitor/package.json services/monitor/
RUN bun install --frozen-lockfile
COPY . .
ARG TARGETARCH
ARG VERSION=0.0.0-docker
RUN bun packages/board/scripts/build.ts --embed \
 && case "$TARGETARCH" in arm64) TARGET=bun-linux-arm64 ;; *) TARGET=bun-linux-x64 ;; esac \
 && bun build --compile --minify --target="$TARGET" \
      --define="process.env.NOTATO_VERSION=\"$VERSION\"" \
      packages/cli/src/main.ts --outfile /out/notato

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN useradd --system --uid 10001 --create-home notato \
 && mkdir /data && chown notato:notato /data
COPY --from=build /out/notato /usr/local/bin/notato
ENV NOTATO_HOST=0.0.0.0 \
    NOTATO_PORT=4747 \
    NOTATO_DIR=/data
VOLUME /data
EXPOSE 4747
USER notato
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["notato", "healthcheck"]
ENTRYPOINT ["notato"]
CMD ["serve"]
