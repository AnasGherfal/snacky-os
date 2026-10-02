import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputPath = path.join("docs", "current-data", "products.csv");
const outputPath = path.join("docs", "current-data", "product_image_candidates.csv");
const sqlPath = path.join("supabase", "migrations", "202605170001_product_image_candidates.sql");

const searchAliases = new Map([
  ["mm", "m&m chocolate"],
  ["7up", "7up drink can"],
  ["Green", "Green Cola can"],
  ["Water", "bottled water"],
  ["Nuts", "mixed nuts snack pack"],
  ["Natural Grape", "grape juice bottle"],
  ["Chocolate Drink", "chocolate milk drink"],
  ["L suntop", "Suntop juice"],
  ["koren Indomie", "Korean Indomie noodles"],
  ["ToraBika capp", "Torabika cappuccino"],
  ["Yasmin Penuts", "Yasmin peanuts"],
  ["Mulino Cookis", "Mulino cookies"],
  ["Caser Juice", "Caesar juice"],
  ["Corissant Karuzo", "Karuzo croissant"],
  ["Kinder bueno1stick", "Kinder Bueno single bar"],
  ["Twix ex", "Twix extra chocolate bar"],
  ["mr.bite strike", "Mr Bite Strike chocolate"],
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.length)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  const [headers, ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function normalizeName(name) {
  return searchAliases.get(name) ?? name;
}

function scoreCandidate(product, candidate) {
  const queryWords = normalizeName(product.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1);
  const haystack = [candidate.product_name, candidate.brands, candidate.categories, candidate.generic_name].join(" ").toLowerCase();
  return queryWords.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

async function findImage(product) {
  const query = normalizeName(product.name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", "10");
  url.searchParams.set("fields", "product_name,brands,categories,generic_name,image_front_url,image_url,url");

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "SnackyOSProductImageMatcher/1.0 (local development)",
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;
    const payload = await response.json();
    const candidates = Array.isArray(payload.products) ? payload.products : [];
    const ranked = candidates
      .filter((candidate) => candidate.image_front_url || candidate.image_url)
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(product, candidate),
        imageUrl: candidate.image_front_url || candidate.image_url,
      }))
      .sort((a, b) => b.score - a.score);

    return ranked[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runPool(items, worker, size = 6) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const products = parseCsv(await readFile(inputPath, "utf8")).filter((product) => product.sku && product.name && !/^test/i.test(product.name));
  const rows = await runPool(products, async (product, index) => {
    const found = await findImage(product);
    console.log(`[${index + 1}/${products.length}] ${product.name}: ${found?.imageUrl ? "candidate" : "missing"}`);
    return {
      sku: product.sku,
      name: product.name,
      search_name: normalizeName(product.name),
      image_url: found?.imageUrl ?? "",
      source_url: found?.candidate.url ?? "",
      matched_name: found?.candidate.product_name ?? "",
      matched_brand: found?.candidate.brands ?? "",
      confidence: found ? (found.score >= 2 ? "review" : "low") : "missing",
    };
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(sqlPath), { recursive: true });

  const headers = ["sku", "name", "search_name", "image_url", "source_url", "matched_name", "matched_brand", "confidence"];
  await writeFile(outputPath, [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n") + "\n");

  const updates = rows
    .filter((row) => row.image_url)
    .map((row) => `  ('${sqlString(row.sku)}', '${sqlString(row.image_url)}', '${sqlString(row.confidence)}')`);

  const sql = `-- Candidate product images found online for admin review.
-- Confidence values are intentionally conservative; confirm visual matches in the product list.

with image_candidates (sku, image_url, confidence) as (
values
${updates.join(",\n")}
)
update products p
set image_url = image_candidates.image_url
from image_candidates
where p.sku = image_candidates.sku
  and image_candidates.confidence = 'review'
  and (p.image_url is null or p.image_url = '');
`;

  await writeFile(sqlPath, sql);

  const foundCount = rows.filter((row) => row.image_url).length;
  console.log(`Found ${foundCount}/${rows.length} product image candidates.`);
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${sqlPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
