import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// --- Disk cache for client_id ---

const CACHE_DIR = join(import.meta.dir, "..", ".cache");
const CLIENT_ID_FILE = join(CACHE_DIR, "sc-client-id.json");
const CLIENT_ID_TTL = 24 * 60 * 60 * 1000; // 24 hours

function readCachedClientId(): string | null {
  try {
    if (!existsSync(CLIENT_ID_FILE)) return null;
    const data = JSON.parse(readFileSync(CLIENT_ID_FILE, "utf-8"));
    if (data.clientId && Date.now() - data.timestamp < CLIENT_ID_TTL) {
      return data.clientId;
    }
  } catch {
    // Corrupt cache — ignore
  }
  return null;
}

function writeCachedClientId(clientId: string) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CLIENT_ID_FILE, JSON.stringify({ clientId, timestamp: Date.now() }));
  } catch {
    // Non-critical
  }
}

// --- In-memory caches with TTL ---

type CacheEntry<T> = { value: T; expires: number };

const oembedCache = new Map<string, CacheEntry<{ title: string; artwork: string | null }>>();
const OEMBED_TTL = 60 * 60 * 1000; // 1 hour

const streamCache = new Map<string, CacheEntry<string>>();
const STREAM_TTL = 10 * 60 * 1000; // 10 minutes (stream URLs expire)

// --- In-flight deduplication ---

const inflightOembed = new Map<string, Promise<{ title: string; artwork: string | null }>>();
const inflightStream = new Map<string, Promise<string>>();
let inflightClientId: Promise<string> | null = null;

// --- oEmbed ---

type OEmbedResponse = {
  title: string;
  thumbnail_url: string | null;
  author_name: string;
  html: string;
};

export async function fetchTrackMeta(url: string): Promise<{ title: string; artwork: string | null }> {
  // Check cache
  const cached = oembedCache.get(url);
  if (cached && Date.now() < cached.expires) return cached.value;

  // Deduplicate in-flight requests
  const inflight = inflightOembed.get(url);
  if (inflight) return inflight;

  const promise = (async () => {
    const endpoint = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(endpoint, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      throw new Error(`SoundCloud oEmbed failed: ${res.status}`);
    }
    const data = (await res.json()) as OEmbedResponse;
    const result = { title: data.title, artwork: data.thumbnail_url ?? null };
    oembedCache.set(url, { value: result, expires: Date.now() + OEMBED_TTL });
    return result;
  })();

  inflightOembed.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightOembed.delete(url);
  }
}

// --- Client ID discovery ---

let cachedClientId: string | null = null;

export async function getClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  // Check environment variable
  if (process.env.SOUNDCLOUD_CLIENT_ID) {
    cachedClientId = process.env.SOUNDCLOUD_CLIENT_ID;
    return cachedClientId;
  }

  // Check disk cache
  const diskCached = readCachedClientId();
  if (diskCached) {
    cachedClientId = diskCached;
    console.log("[soundcloud] Using cached client_id from disk");
    return cachedClientId;
  }

  // Deduplicate in-flight scrapes
  if (inflightClientId) return inflightClientId;

  inflightClientId = (async () => {
    console.log("[soundcloud] Scraping client_id from soundcloud.com...");
    const pageRes = await fetch("https://soundcloud.com", {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!pageRes.ok) {
      throw new Error(`Failed to fetch soundcloud.com: ${pageRes.status}`);
    }
    const html = await pageRes.text();

    const scriptPattern = /<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
    const scriptUrls: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = scriptPattern.exec(html)) !== null) {
      scriptUrls.push(match[1]);
    }

    const candidates = scriptUrls.slice(-3);
    const clientIdPattern = /client_id[=:]["']?([a-zA-Z0-9]{32})/;

    for (const scriptUrl of candidates) {
      try {
        const scriptRes = await fetch(scriptUrl, {
          headers: { "User-Agent": USER_AGENT },
        });
        if (!scriptRes.ok) continue;
        const js = await scriptRes.text();
        const cidMatch = clientIdPattern.exec(js);
        if (cidMatch) {
          cachedClientId = cidMatch[1];
          writeCachedClientId(cachedClientId);
          console.log("[soundcloud] client_id discovered and cached to disk");
          return cachedClientId;
        }
      } catch {
        // Try next script
      }
    }

    throw new Error("Could not discover SoundCloud client_id");
  })();

  try {
    return await inflightClientId;
  } finally {
    inflightClientId = null;
  }
}

export function clearCachedClientId() {
  cachedClientId = null;
  // Don't clear disk cache here — the retry logic will re-scrape if needed
}

// --- Stream URL resolution ---

const NEEDS_RETRY = Symbol("needs_retry");

export async function resolveStreamUrl(trackUrl: string): Promise<string> {
  // Check cache
  const cached = streamCache.get(trackUrl);
  if (cached && Date.now() < cached.expires) return cached.value;

  // Deduplicate in-flight requests
  const inflight = inflightStream.get(trackUrl);
  if (inflight) return inflight;

  const promise = (async () => {
    async function attempt(): Promise<string | typeof NEEDS_RETRY> {
      const clientId = await getClientId();

      const resolveEndpoint = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${clientId}`;
      const resolveRes = await fetch(resolveEndpoint, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (resolveRes.status === 401 || resolveRes.status === 403) {
        clearCachedClientId();
        return NEEDS_RETRY;
      }
      if (!resolveRes.ok) {
        throw new Error(`SoundCloud resolve failed: ${resolveRes.status}`);
      }

      const trackData = (await resolveRes.json()) as any;

      const transcodings: any[] | undefined = trackData?.media?.transcodings;
      if (!Array.isArray(transcodings) || transcodings.length === 0) {
        throw new Error("No transcodings found in track data");
      }

      let transcoding = transcodings.find(
        (t: any) =>
          t.format?.protocol === "progressive" &&
          t.format?.mime_type?.includes("mpeg"),
      );
      if (!transcoding) {
        transcoding = transcodings.find(
          (t: any) => t.format?.protocol === "progressive",
        );
      }
      if (!transcoding) {
        transcoding = transcodings.find(
          (t: any) => t.format?.protocol === "hls",
        );
      }
      if (!transcoding?.url) {
        throw new Error("No suitable transcoding found (no progressive or HLS)");
      }

      const streamEndpoint = `${transcoding.url}?client_id=${clientId}&track_authorization=${trackData.track_authorization}`;
      const streamRes = await fetch(streamEndpoint, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (streamRes.status === 401 || streamRes.status === 403) {
        clearCachedClientId();
        return NEEDS_RETRY;
      }
      if (!streamRes.ok) {
        throw new Error(`Stream URL fetch failed: ${streamRes.status}`);
      }

      const streamData = (await streamRes.json()) as any;
      if (!streamData?.url) {
        throw new Error("Stream response missing url field");
      }
      return streamData.url;
    }

    const result = await attempt();
    if (result !== NEEDS_RETRY) {
      streamCache.set(trackUrl, { value: result, expires: Date.now() + STREAM_TTL });
      return result;
    }

    console.warn("[soundcloud] Retrying stream URL resolution with fresh client_id");
    const retryResult = await attempt();
    if (retryResult !== NEEDS_RETRY) {
      streamCache.set(trackUrl, { value: retryResult, expires: Date.now() + STREAM_TTL });
      return retryResult;
    }

    throw new Error("SoundCloud stream URL resolution failed after retry (auth error)");
  })();

  inflightStream.set(trackUrl, promise);
  try {
    return await promise;
  } finally {
    inflightStream.delete(trackUrl);
  }
}
