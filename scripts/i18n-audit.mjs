#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const roots = [
  "src/lib/i18n",
  "src/app/layout.tsx",
  "src/components/Sidebar.tsx",
  "src/components/operator",
  "src/components",
  "src/app/dashboard/page.tsx",
  "src/app/routes",
  "src/app/storage-locations",
];

const suspiciousPatterns = ["ÃƒÆ’", "ÃƒÂ¢", "Ãƒâ€š", "Ã¢â‚¬", "Ã¢", "Ã‚", "Â", "â€", "Ø", "Ù", "Ùƒ", "Ø§", "�"];
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"]);

function collectFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return allowedExtensions.has(path.extname(target)) ? [target] : [];
  }
  const entries = fs.readdirSync(target, { withFileTypes: true });
  return entries.flatMap((entry) => collectFiles(path.join(target, entry.name)));
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

if (hits.length) {
  console.error("i18n audit failed: mojibake detected in UI source files.");
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`);
  }
  process.exit(1);
}

console.log("i18n audit passed: no mojibake detected in UI source files.");
