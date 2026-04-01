type OEmbedResponse = {
  title: string;
  thumbnail_url: string | null;
  author_name: string;
  html: string;
};

export async function fetchTrackMeta(url: string): Promise<{ title: string; artwork: string | null }> {
  const endpoint = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`SoundCloud oEmbed failed: ${res.status}`);
  }
  const data = (await res.json()) as OEmbedResponse;
  return {
    title: data.title,
    artwork: data.thumbnail_url ?? null,
  };
}

// --- Client ID discovery & stream URL resolution ---

let cachedClientId: string | null = null;

export async function getClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  // Check environment variable first
  if (process.env.SOUNDCLOUD_CLIENT_ID) {
    cachedClientId = process.env.SOUNDCLOUD_CLIENT_ID;
    return cachedClientId;
  }

  // Scrape client_id from soundcloud.com
  const pageRes = await fetch("https://soundcloud.com", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; vibez/1.0)" },
  });
  if (!pageRes.ok) {
    throw new Error(`Failed to fetch soundcloud.com: ${pageRes.status}`);
  }
  const html = await pageRes.text();

  // Find cross-origin script tags pointing to sndcdn.com assets
  const scriptPattern = /<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
  const scriptUrls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    scriptUrls.push(match[1]);
  }

  // Fetch last 2-3 scripts (client_id is typically in the later bundles)
  const candidates = scriptUrls.slice(-3);
  const clientIdPattern = /client_id[=:]["']?([a-zA-Z0-9]{32})/;

  for (const scriptUrl of candidates) {
    try {
      const scriptRes = await fetch(scriptUrl);
      if (!scriptRes.ok) continue;
      const js = await scriptRes.text();
      const cidMatch = clientIdPattern.exec(js);
      if (cidMatch) {
        cachedClientId = cidMatch[1];
        return cachedClientId;
      }
    } catch {
      // Try next script
    }
  }

  throw new Error("Could not discover SoundCloud client_id");
}

export function clearCachedClientId() {
  cachedClientId = null;
}

const NEEDS_RETRY = Symbol("needs_retry");

export async function resolveStreamUrl(trackUrl: string): Promise<string> {
  async function attempt(): Promise<string | typeof NEEDS_RETRY> {
    const clientId = await getClientId();

    // Resolve track URL to full track data
    const resolveEndpoint = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${clientId}`;
    const resolveRes = await fetch(resolveEndpoint);

    if (resolveRes.status === 401 || resolveRes.status === 403) {
      clearCachedClientId();
      return NEEDS_RETRY;
    }
    if (!resolveRes.ok) {
      throw new Error(`SoundCloud resolve failed: ${resolveRes.status}`);
    }

    const trackData = (await resolveRes.json()) as any;

    // Find transcodings
    const transcodings: any[] | undefined = trackData?.media?.transcodings;
    if (!Array.isArray(transcodings) || transcodings.length === 0) {
      throw new Error("No transcodings found in track data");
    }

    // Prefer progressive with audio/mpeg, then any progressive, then HLS fallback
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

    // Fetch the actual stream URL
    const streamEndpoint = `${transcoding.url}?client_id=${clientId}&track_authorization=${trackData.track_authorization}`;
    const streamRes = await fetch(streamEndpoint);

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

  // First attempt
  const result = await attempt();
  if (result !== NEEDS_RETRY) return result;

  // Retry once with freshly scraped client_id (cache was already cleared)
  console.warn("[soundcloud] Retrying stream URL resolution with fresh client_id");
  const retryResult = await attempt();
  if (retryResult !== NEEDS_RETRY) return retryResult;

  throw new Error("SoundCloud stream URL resolution failed after retry (auth error)");
}
