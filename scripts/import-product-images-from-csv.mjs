import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const inputPath = path.join("docs", "current-data", "products.csv");
const bucket = "product-images";
const maxSizeBytes = 5 * 1024 * 1024;
const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const imageRoots = [
  process.env.PRODUCT_IMAGE_ROOT,
  "Items_Images",
  path.join("docs", "current-data", "Items_Images"),
  path.join("docs", "Items_Images"),
  path.join("public", "Items_Images"),
].filter(Boolean);

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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findLocalImage(csvImagePath) {
  if (!csvImagePath) return null;
  const relativePath = csvImagePath.replace(/^Items_Images[\\/]/, "");
  const extension = path.extname(relativePath).toLowerCase();
  if (!allowedExtensions.has(extension)) return null;

  for (const root of imageRoots) {
    const candidate = path.resolve(root, relativePath);
    if (await fileExists(candidate)) return candidate;
  }

  return null;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this importer.");
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const bucketConfig = {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  };
  const { error: createBucketError } = await supabase.storage.createBucket(bucket, bucketConfig);
  if (createBucketError && !createBucketError.message.toLowerCase().includes("already exists")) {
    throw createBucketError;
  }
  if (createBucketError) {
    const { error: updateBucketError } = await supabase.storage.updateBucket(bucket, bucketConfig);
    if (updateBucketError) throw updateBucketError;
  }

  const products = parseCsv(await readFile(inputPath, "utf8")).filter((product) => product.sku && product.image);
  let uploaded = 0;
  let missing = 0;
  let skipped = 0;

  for (const product of products) {
    const localImage = await findLocalImage(product.image);
    if (!localImage) {
      missing += 1;
      continue;
    }

    const stats = await stat(localImage);
    if (stats.size > maxSizeBytes) {
      skipped += 1;
      console.warn(`Skipping ${product.sku}: ${localImage} is larger than 5MB.`);
      continue;
    }

    const extension = path.extname(localImage).toLowerCase();
    const objectPath = `${product.sku}${extension}`;
    const fileBuffer = await readFile(localImage);
    const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, fileBuffer, {
      cacheControl: "31536000",
      contentType: contentTypeFor(localImage),
      upsert: true,
    });
    if (uploadError) throw uploadError;

    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    const { error: updateError } = await supabase.from("products").update({ image_url: data.publicUrl }).eq("sku", product.sku);
    if (updateError) throw updateError;
    uploaded += 1;
  }

  console.log(`Uploaded ${uploaded} CSV product images to ${bucket}.`);
  console.log(`Missing local files for ${missing} CSV image paths.`);
  console.log(`Skipped ${skipped} files over 5MB.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
