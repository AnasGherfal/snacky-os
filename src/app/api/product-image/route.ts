const ALLOWED_HOST = "wc.xyvend.cn";
const ALLOWED_PORT = "8086";
const ALLOWED_PATH_PREFIX = "/spImg/";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isAllowedProductImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname === ALLOWED_HOST &&
      url.port === ALLOWED_PORT &&
      url.pathname.startsWith(ALLOWED_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const imageUrl = requestUrl.searchParams.get("url")?.trim() ?? "";

  if (!imageUrl || !isAllowedProductImageUrl(imageUrl)) {
    return new Response("Product image not found", { status: 404 });
  }

  try {
    const upstream = await fetch(imageUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });

    if (!upstream.ok) {
      return new Response("Product image unavailable", { status: 404 });
    }

    const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!contentType.startsWith("image/")) {
      return new Response("Invalid product image", { status: 415 });
    }

    const contentLength = Number(upstream.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      return new Response("Product image too large", { status: 413 });
    }

    const image = await upstream.arrayBuffer();
    if (image.byteLength > MAX_IMAGE_BYTES) {
      return new Response("Product image too large", { status: 413 });
    }

    return new Response(image, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Product image unavailable", { status: 404 });
  }
}
