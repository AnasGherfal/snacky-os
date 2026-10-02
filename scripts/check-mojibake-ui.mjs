import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const patterns = ["Ãƒ", "Ã¢", "Ã‚", "Ã", "Â", "â€", "Ø", "Ù", "�"];
const targets = [
  "src/lib/i18n",
  "src/lib/storage-locations.ts",
  "src/lib/vms-dashboard-source.ts",
  "src/components/StorageLocationForm.tsx",
  "src/components/AppShell.tsx",
  "src/components/Topbar.tsx",
  "src/app/layout.tsx",
  "src/app/storage-locations",
  "src/app/vms-import/sources/page.tsx",
];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walk(entryPath) {
  const info = await stat(entryPath);
  if (info.isFile()) {
    yield entryPath;
    return;
  }
  for (const child of await (await import("node:fs/promises")).readdir(entryPath, { withFileTypes: true })) {
    const childPath = path.join(entryPath, child.name);
    if (child.isDirectory()) {
      yield* walk(childPath);
    } else if (/\.(?:ts|tsx|js|mjs|cjs|json)$/i.test(child.name)) {
      yield childPath;
    }
  }
}

const hits = [];
for (const target of targets) {
  const absolute = path.join(root, target);
  if (!(await exists(absolute))) continue;
  for await (const filePath of walk(absolute)) {
    const text = await readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const pattern = patterns.find((needle) => line.includes(needle));
      if (pattern) {
        hits.push(`${path.relative(root, filePath)}:${index + 1}: ${pattern} ${line.trim()}`);
      }
    }
  }
}

if (hits.length) {
  console.error("Mojibake detected in UI/i18n files:");
  for (const hit of hits) console.error(hit);
  process.exit(1);
}

console.log("No mojibake detected in UI/i18n files.");
