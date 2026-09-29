type ProductThumbnailProps = {
  imageUrl?: string | null;
  name?: string | null;
  size?: "sm" | "md";
};

function displayImageUrl(imageUrl?: string | null) {
  const value = imageUrl?.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname === "wc.xyvend.cn" &&
      parsed.port === "8086" &&
      parsed.pathname.startsWith("/spImg/")
    ) {
      return `/api/product-image?url=${encodeURIComponent(value)}`;
    }
  } catch {
    return null;
  }

  return value;
}

export function ProductThumbnail({ imageUrl, name, size = "sm" }: ProductThumbnailProps) {
  const dimensions = size === "md" ? "h-12 w-12" : "h-10 w-10";
  const pixelSize = size === "md" ? 48 : 40;
  const initials = String(name || "?").trim().slice(0, 2).toUpperCase() || "?";
  const displayUrl = displayImageUrl(imageUrl);

  if (displayUrl) {
    return (
      <img
        src={displayUrl}
        alt={name ? `${name} product image` : "Product image"}
        width={pixelSize}
        height={pixelSize}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={`${dimensions} shrink-0 rounded-md border border-slate-200 bg-white object-cover`}
      />
    );
  }

  return (
    <div className={`${dimensions} flex shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-xs font-semibold text-slate-500`}>
      {initials}
    </div>
  );
}
