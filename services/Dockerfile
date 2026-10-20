# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
WORKDIR /src
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
RUN bun run build:service

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/services ./services
COPY --from=build /src/sdks/browser ./sdks/browser
ARG VERSION=0.0.0-docker
LABEL org.opencontainers.image.version=$VERSION org.opencontainers.image.source=https://github.com/notatorg/notato org.opencontainers.image.licenses=MIT
RUN chmod -R a+rX packages services sdks && mkdir /data && chown bun:bun /data && chmod 700 /data
ENV NOTATO_HOST=0.0.0.0 NOTATO_PORT=4799 NOTATO_DIR=/data NOTATO_CONFIG=/data/notato.config.json NOTATO_WEB_DIST=/app/services/board/dist NODE_ENV=production
USER bun
EXPOSE 4799
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "services/cli/src/main.ts", "healthcheck"]
ENTRYPOINT ["bun", "services/cli/src/main.ts"]
CMD ["serve"]
