import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirs = ["app", "core", "features", "i18n", "storage", "ui"];

for (const dir of runtimeDirs) {
  await rm(resolve(root, dir), { recursive: true, force: true });
  await mkdir(resolve(root, dir), { recursive: true });
  await cp(resolve(root, "build", dir), resolve(root, dir), { recursive: true });
}

await copyFile(resolve(root, "build", "app.js"), resolve(root, "app.js"));
await copyFile(resolve(root, "source", "ui", "trade-logo.png"), resolve(root, "ui", "trade-logo.png"));
console.log("Published compiled modules to repository root.");
