// Overwritten by `bun packages/board/scripts/build.ts --embed`, which lists the built board UI here so
// `bun build --compile` embeds it in the binary. This stub is what the repository keeps: a binary built with it has
// no board at `/`, and a server run from source serves packages/board/dist, once `bun run build:board` has made it.
export const webAssets: Record<string, { path: string; type: string }> | null = null
