// Builds the self-contained single-file binary (frontend + backend + DSP).
//
//   bun run scripts/package.ts                 # host platform → dist/sdr
//   bun run scripts/package.ts bun-darwin-arm64 bun-linux-x64 bun-windows-x64
//
// Steps: build the web app, embed its assets into the server (gen-embed.ts),
// `bun build --compile` one binary per target, then restore the committed empty
// embedded.ts so the working tree / dev / typecheck stay clean.
//
// The binary still needs `rtl_tcp` (librtlsdr) installed on the user's machine —
// it drives the USB dongle. The binary bundles everything else.

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = `${import.meta.dir}/..`;
$.cwd(ROOT);

const targets = process.argv.slice(2); // e.g. bun-darwin-arm64; empty = host
const OUT = "dist";

// Back up the committed (empty) embedded manifest so we can restore it after
// compiling. gen-embed.ts overwrites it; we must not leave the generated file
// (with its dist/ imports) behind, or dev/typecheck break once dist is gone.
const EMBEDDED = `${ROOT}/packages/server/src/embedded.ts`;
const DEFAULT_EMBEDDED =
  "export interface EmbeddedAsset { path: string; type: string; }\n" +
  "export const EMBEDDED: Record<string, EmbeddedAsset> = {};\n" +
  "export const HAS_EMBEDDED = false;\n";
let backup = DEFAULT_EMBEDDED;
try {
  const cur = readFileSync(EMBEDDED, "utf8");
  if (!cur.includes("HAS_EMBEDDED = true")) backup = cur; // not a stale generated file
} catch {
  /* fall back to the minimal default */
}

console.log("[package] building web frontend…");
await $`bun --filter @sdr/web build`;

console.log("[package] embedding assets…");
await $`bun run packages/server/scripts/gen-embed.ts`;

try {
  await $`mkdir -p ${OUT}`;
  if (targets.length === 0) {
    console.log("[package] compiling host binary → dist/sdr");
    await $`bun build packages/server/src/index.ts --compile --minify --outfile ${OUT}/sdr`;
  } else {
    for (const t of targets) {
      const name = `sdr-${t.replace(/^bun-/, "")}${t.includes("windows") ? ".exe" : ""}`;
      console.log(`[package] compiling ${t} → dist/${name}`);
      await $`bun build packages/server/src/index.ts --compile --minify --target=${t} --outfile ${OUT}/${name}`;
    }
  }
} finally {
  // Restore the empty manifest so the working tree / dev / typecheck stay clean.
  writeFileSync(EMBEDDED, backup);
}

console.log("[package] done. Binaries are in dist/.");
console.log("[package] note: users must have `rtl_tcp` (librtlsdr) installed.");
