/** Read-only extraction of XY dashboard's public JavaScript assets.
 * Attribute values can be unquoted on the production page.
 */
export function discoverXyDashboardAssets(source: string, base: string): string[] {
  const urls = new Set<string>();
  for (const element of source.matchAll(/<(?:script|link|iframe)\b[^>]*>/gi)) {
    for (const attribute of element[0].matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
      const raw = (attribute[1] ?? attribute[2] ?? attribute[3] ?? "").replace(/&amp;/g, "&");
      try {
        const resolved = new URL(raw, base);
        if (resolved.protocol !== "https:") continue;
        if (!/(^|\.)xynetweb\.com$/i.test(resolved.hostname)) continue;
        if (!/\.js$/i.test(resolved.pathname)) continue;
        urls.add(resolved.toString());
      } catch {
        // Broken/relative javascript attribute; never guess a target.
      }
    }
  }
  return [...urls];
}
