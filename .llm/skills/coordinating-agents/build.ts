#!/usr/bin/env bun
import { spawnSync } from "bun";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(Bun.fileURLToPath(import.meta.url));
const binDir = join(here, "bin");
if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

const out = join(binDir, "phloem");
const aliasOut = join(binDir, "ph");
const src = join(here, "main.ts");

console.log(`Building phloem → ${out}`);
const r = spawnSync([
  "bun",
  "build",
  src,
  "--compile",
  "--target=bun-linux-x64-modern",
  "--bytecode",
  "--format=esm",
  "--minify",
  "--production",
  "--outfile",
  out,
]);
if (r.exitCode !== 0) {
  process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
console.log("phloem built.");

writeFileSync(
  aliasOut,
  "#!/usr/bin/env bash\nexec \"$(dirname \"$0\")/phloem\" \"$@\"\n",
);
chmodSync(aliasOut, 0o755);
console.log(`ph alias written → ${aliasOut}`);
