import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "bun";

const repoRoot = process.cwd();
const srcDir = join(repoRoot, "src");
const binDir = join(repoRoot, "bin");
const buildTarget = process.env.BUN_BUILD_TARGET || "bun-linux-x64-modern";
const runtimeLibRoot = join(repoRoot, "lib", "onnxruntime");

console.log("== building fleet binaries ==");

if (!existsSync(binDir)) mkdirSync(binDir);

function runOrDie(cmd: string[]) {
  const result = spawnSync(cmd);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function syncOnnxRuntimeLib() {
  if (!buildTarget.startsWith("bun-linux-")) return;

  const arch = buildTarget.includes("-arm64") ? "arm64" : "x64";
  const source = join(repoRoot, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", arch, "libonnxruntime.so.1");
  const targetDir = join(runtimeLibRoot, "linux", arch);
  const target = join(targetDir, "libonnxruntime.so.1");

  if (!existsSync(source)) {
    console.warn(`Skipping ONNX runtime library sync; missing ${source}`);
    return;
  }

  ensureDir(targetDir);
  copyFileSync(source, target);
  console.log(`Synced ONNX runtime library → ${target}`);
}

const runtimeModules = [
  ["fleet", "fleet"],
  ["agent-mail", "agent-mail"],
  ["agent-runtime", "agent-runtime"],
  ["operator-console", "operator-console"],
  ["agent-state", "agent-state"],
  ["agent-jobs", "agent-jobs"],
  ["agent-memory", "agent-memory"],
  ["fleet-reporter", "fleet-reporter"],
  ["fleet-librarian", "fleet-librarian"],
  ["fleet-digest", "fleet-digest"],
  ["inference-local-embed", "inference-local-embed"],
  ["inference-local-rerank", "inference-local-rerank"],
  ["inference-local-small", "inference-local-small"],
  ["inference-local-medium", "inference-local-medium"],
  ["inference-cloud-anthropic", "inference-cloud-anthropic"],
  ["inference-cloud-google", "inference-cloud-google"],
  ["inference-cloud-openai", "inference-cloud-openai"],
  ["inference-cloud-openrouter", "inference-cloud-openrouter"],
];

for (const [mod, name] of runtimeModules) {
  console.log(`Building ${name} for ${buildTarget}...`);
  runOrDie([
    "bun",
    "build",
    join(srcDir, mod, "main.ts"),
    "--compile",
    `--target=${buildTarget}`,
    "--bytecode",
    "--format=esm",
    "--minify",
    "--production",
    "--outfile",
    join(binDir, name),
  ]);
}

console.log("Build complete.");
syncOnnxRuntimeLib();
