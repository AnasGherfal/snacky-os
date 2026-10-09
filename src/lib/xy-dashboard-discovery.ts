import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { discoverXyDashboardAssets } from "@/lib/xy-public-asset-paths";

const ROOT_URL = "https://www.xynetweb.com/";
const MAX_FILES = 16;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 12000;

type Candidate = {
  value: string;
  source_url: string;
  evidence: string[];
  score: number;
};

function safeUrl(value: string, base: string) {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!/(^|\.)xynetweb\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function discoverBootstrapUrls(source: string, base: string) {
  const urls = new Set(discoverXyDashboardAssets(source, base));
  const patterns = [
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>;]+)[^"']*["']/gi,
    /(?:window\\.)?location(?:\\.href)?\\s*=\\s*["']([^"']+)["']/gi,
    /(https?:\\/\\/[A-Za-z0-9._:-]*xynetweb\\.com[^"'\\s<]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const resolved = safeUrl(String(match[1] ?? "").trim(), base);
      if (resolved) urls.add(resolved);
    }
  }
  return [...urls];
}

function discoverJsUrls(source: string, base: string) {
  const urls = new Set(discoverXyDashboardAssets(source, base));
  for (const match of source.matchAll(/["']([^"'\\s]+\\.js(?:\\?[^"'\\s]*)?)["']/g)) {
    const resolved = safeUrl(String(match[1] ?? ""), base);
    if (resolved) urls.add(resolved);
  }
  return [...urls];
}

function snippet(source: string, index: number) {
  return source
    .slice(Math.max(0, index - 180), Math.min(source.length, index + 220))
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function scoreCandidate(value: string) {
  const text = value.toLowerCase();
  let score = 0;
  if (text.includes("/sram/")) score += 12;
  if (text.includes("order")) score += 10;
  if (text.includes("transaction")) score += 10;
  if (text.includes("sale")) score += 9;
  if (text.includes("trade")) score += 8;
  if (text.includes("payment")) score += 7;
  if (text.includes("report")) score += 5;
  if (text.includes("archive")) score += 4;
  if (text.includes("detail")) score += 3;
  if (text.includes("list")) score += 2;
  return score;
}

function extractCandidates(source: string, sourceUrl: string) {
  const result = new Map<string, Candidate>();
  const keyword = /(order|sale|sales|trade|transaction|payment|report|archive|archives|订单|销售|交易|支付|报表|流水)/i;
  const patterns = [
    /["']([^"'\s]{4,260})["']/g,
    /(https?:\/\/[^"'\s)]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let value = String(match[1] || "").replace(/\\\//g, "/").trim();
      if (!value || !keyword.test(value)) continue;
      if (!value.includes("/") && !/^query[A-Z]/.test(value)) continue;
      const score = scoreCandidate(value);
      if (score < 5) continue;

      const evidence = snippet(source, match.index || 0);
      const existing = result.get(value);
      if (existing) {
        if (!existing.evidence.includes(evidence) && existing.evidence.length < 3) existing.evidence.push(evidence);
      } else {
        result.set(value, {
          value,
          source_url: sourceUrl,
          evidence: [evidence],
          score,
        });
      }
    }
  }

  return Array.from(result.values());
}

async function fetchText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 Snacky-XY-ReadOnly-Discovery/1.0",
        Accept: "text/html,application/javascript,text/javascript,*/*;q=0.8",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url || url,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createRun() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data, error } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy_web",
      sync_type: "dashboard_asset_discovery",
      status: "running",
      endpoint: ROOT_URL,
      request_summary: {
        mode: "public_read_only_asset_scan",
        max_files: MAX_FILES,
        max_total_bytes: MAX_TOTAL_BYTES,
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new Error("Could not create dashboard discovery run: " + (error?.message || "missing id"));
  }

  return { supabase, runId: String(data.id) };
}

export async function discoverXyDashboardSalesApi() {
  const { supabase, runId } = await createRun();
  const queue: string[] = [ROOT_URL];
  const visited = new Set<string>();
  const candidateMap = new Map<string, Candidate>();
  const files: Array<{ url: string; status: number; bytes: number; content_type: string }> = [];
  const errors: string[] = [];
  let totalBytes = 0;
  let rootPreview = "";
  let rootBootstrapUrls: string[] = [];

  try {
    while (queue.length && visited.size < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
      const requested = queue.shift();
      if (!requested || visited.has(requested)) continue;
      visited.add(requested);

      try {
        const response = await fetchText(requested);
        const bytes = Buffer.byteLength(response.text, "utf8");
        totalBytes += bytes;
        files.push({
          url: response.finalUrl,
          status: response.status,
          bytes,
          content_type: response.contentType,
        });

        if (requested === ROOT_URL) {
          rootPreview = response.text.slice(0, 5000);
          rootBootstrapUrls = discoverBootstrapUrls(response.text, response.finalUrl).slice(0, 50);
        }

        if (!response.ok) continue;

        for (const candidate of extractCandidates(response.text, response.finalUrl)) {
          const current = candidateMap.get(candidate.value);
          if (!current) {
            candidateMap.set(candidate.value, candidate);
          } else {
            for (const evidence of candidate.evidence) {
              if (!current.evidence.includes(evidence) && current.evidence.length < 3) current.evidence.push(evidence);
            }
          }
        }

        const discoveredUrls = [
          ...discoverJsUrls(response.text, response.finalUrl),
          ...(requested === ROOT_URL || /text\/html/i.test(response.contentType)
            ? discoverBootstrapUrls(response.text, response.finalUrl)
            : []),
        ].sort((left, right) => {
          const weight = (url: string) => {
            const path = new URL(url).pathname.toLowerCase();
            if (/\/(?:app|main)\.[a-z0-9]+\.js$/.test(path)) return 0;
            if (path.includes("manifest")) return 1;
            return 2;
          };
          return weight(left) - weight(right);
        });
        for (const url of discoveredUrls) {
          if (!visited.has(url) && queue.length < MAX_FILES * 2) queue.push(url);
        }
      } catch (error) {
        errors.push(requested + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }

    const candidates = Array.from(candidateMap.values())
      .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .slice(0, 200);

    const message = candidates.length
      ? "XY dashboard asset scan found " + candidates.length + " sales/order API candidates."
      : "XY dashboard asset scan found no sales/order API candidates.";

    const { error: saveError } = await supabase
      .from("vms_sync_runs")
      .update({
        status: errors.length ? "completed_with_warnings" : "completed",
        row_count: files.length,
        rows_imported: 0,
        rows_updated: 0,
        rows_skipped: 0,
        error_count: errors.length,
        message,
        response_summary: {
          root_url: ROOT_URL,
          root_preview: rootPreview,
          root_bootstrap_urls: rootBootstrapUrls,
          files_scanned: files.length,
          total_bytes: totalBytes,
          candidates,
          files: files.slice(0, 150),
        },
        errors: errors.slice(0, 50),
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (saveError) throw new Error("Could not save dashboard discovery: " + saveError.message);

    return {
      runId,
      filesScanned: files.length,
      totalBytes,
      candidates,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("vms_sync_runs")
      .update({
        status: "failed",
        error_count: 1,
        message: "XY dashboard asset discovery failed",
        errors: [message],
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    throw error;
  }
}
