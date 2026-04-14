import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const srcDir = join(process.cwd(), "src");
const binDir = join(process.cwd(), "bin");

if (!existsSync(binDir)) {
  mkdirSync(binDir);
}

const entries = readdirSync(srcDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name);

for (const entry of entries) {
  const dirPath = join(srcDir, entry);
  let entryPoint = "";

  if (existsSync(join(dirPath, "main.ts"))) {
    entryPoint = join(dirPath, "main.ts");
  } else if (existsSync(join(dirPath, "server.ts"))) {
    entryPoint = join(dirPath, "server.ts");
  }

  if (entryPoint) {
    console.log(`Building ${entry}...`);
    const proc = Bun.spawn([
      "bun",
      "build",
      "--compile",
      "--minify",
      entryPoint,
      "--outfile",
      join(binDir, entry),
    ]);

    const result = await proc.exited;
    if (result !== 0) {
      console.error(`Failed to build ${entry}`);
    }
  }
}
