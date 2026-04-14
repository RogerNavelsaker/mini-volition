import { readdirSync, existsSync, mkdirSync, unlinkSync, rmSync, writeFileSync, chmodSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "bun";

const repoRoot = process.cwd();
const srcDir = join(repoRoot, "src");
const binDir = join(repoRoot, "bin");
const buildDir = join(repoRoot, "build");

console.log("== building fleet binaries ==");

if (!existsSync(binDir)) mkdirSync(binDir);
if (!existsSync(buildDir)) mkdirSync(buildDir);

function runOrDie(cmd: string[]) {
  const result = spawnSync(cmd);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
}

// Clean stale build artifacts
for (const stale of [join(repoRoot, "fleet"), join(buildDir, "fleet")]) {
  try { unlinkSync(stale); } catch {}
}

// 1. Compile core binaries
const coreModules = [
  ["fleet", "fleet"],
  ["agent-mail", "agent-mail"],
  ["agent-harness", "agent-harness"],
  ["operator-harness", "operator-harness"],
  ["agent-state", "agent-state"],
  ["agent-jobs", "agent-jobs"],
  ["agent-memory", "agent-memory"],
  ["fleet-digest", "fleet-digest"],
  ["fleet-librarian", "fleet-librarian"],
];

for (const [mod, name] of coreModules) {
  console.log(`Building ${name}...`);
  runOrDie(["bun", "build", join(srcDir, mod, "main.ts"), "--compile", "--minify", "--outfile", join(binDir, name)]);
}

// 2. Build inference and provider workers (Bundles + Wrappers)
// Inference workers: embed, rerank, light, heavy
const inferenceWorkers = [
  [join(srcDir, "fleet-embed", "main.ts"), "fleet-embed"],
  [join(srcDir, "fleet-rerank", "main.ts"), "fleet-rerank"],
  [join(srcDir, "fleet-light", "main.ts"), "fleet-light"],
  [join(srcDir, "fleet-heavy", "main.ts"), "fleet-heavy"],
];

// Provider workers: claude, gemini, openai, openrouter
const providerWorkers = [
  [join(srcDir, "fleet-claude", "main.ts"), "fleet-claude"],
  [join(srcDir, "fleet-gemini", "main.ts"), "fleet-gemini"],
  [join(srcDir, "fleet-openai", "main.ts"), "fleet-openai"],
  [join(srcDir, "fleet-openrouter", "main.ts"), "fleet-openrouter"],
];

for (const [src, name] of [...inferenceWorkers, ...providerWorkers]) {
  console.log(`Bundling ${name}...`);
  const bundle = join(buildDir, `${name}.mjs`);
  runOrDie(["bun", "build", "--target=bun", "--packages=external", src, "--outfile", bundle]);
  
  const binPath = join(binDir, name);
  writeFileSync(binPath, `#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
export NODE_PATH="$repo_root/build/node_modules"
cd "$repo_root"
exec bun "$repo_root/build/${name}.mjs" "$@"
`, "utf-8");
  chmodSync(binPath, 0o755);
}

console.log("Build complete.");
