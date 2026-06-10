// Static frontend assets embedded into the compiled single-file binary.
//
// This default (empty) version is what the repo ships and what runs in dev,
// where Vite serves the frontend itself. The packaging build regenerates this
// file from packages/web/dist via scripts/gen-embed.ts — turning each built
// asset into a `with { type: "file" }` import that `bun build --compile` bakes
// into the executable — then restores this empty default afterwards.

export interface EmbeddedAsset {
  /** Path Bun resolves to the embedded bytes at runtime. */
  path: string;
  /** Content-Type to serve it with. */
  type: string;
}

/** Map of URL path (e.g. "/assets/index-abc.js") → embedded asset. */
export const EMBEDDED: Record<string, EmbeddedAsset> = {};

/** True only in a packaged binary (the frontend is embedded). */
export const HAS_EMBEDDED = false;
