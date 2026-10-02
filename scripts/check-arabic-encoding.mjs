#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const roots = [
  "src/lib/i18n",
  "src/app/layout.tsx",
  "src/components",
  "src/app/routes/[id]/edit/page.tsx",
];

const suspiciousPatterns = ["Ãƒ", "Ã¢", "Ã‚", "â€", "Ø", "Ù", "Ùƒ", "Ø§", "�"];
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"]);

function collectFiles(target) {
  if (!fs.existsSync(target)) {
    return [];
  }

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return allowedExtensions.has(path.extname(target)) ? [target] : [];
  }

  const entries = fs.readdirSync(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    files.push(...collectFiles(path.join(target, entry.name)));
  }
  return files;
}

function scanFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const matches = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const pattern of suspiciousPatterns) {
      if (line.includes(pattern)) {
        matches.push({ line: index + 1, pattern, text: line.trim() });
        break;
      }
    }
  }

  return matches;
}

const files = roots.flatMap(collectFiles);
const hits = [];

for (const file of files) {
  for (const match of scanFile(file)) {
    hits.push({ file, ...match });
  }
}

if (hits.length > 0) {
  console.error("Mojibake detected in UI translation sources:");
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`);
  }
  process.exit(1);
}

console.log("No mojibake detected in UI translation sources.");
