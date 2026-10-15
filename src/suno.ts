import type { TrackRef } from "./soundcloud";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SUNO_HOSTS = new Set(["suno.com", "www.suno.com", "app.suno.ai"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SONG_HINT = "Paste a suno.com/song/… or suno.com/s/… link.";

const SONG_TTL = 10 * 60 * 1000;

export type SunoLink =
  | { kind: "song"; uuid: string }
  | { kind: "short"; code: string }
  | { kind: "playlist" }
  | { kind: "profile" }
  | { kind: "other" };

export type SunoPage = {
  title: string | null;
  artwork: string | null;
  /** Seconds, from the embedded song JSON. Absent when the page doesn't include it. */
  durationSec: number | null;
  /** Public cloudfront clip for this song, when the page lists one. May be DRM-wrapped. */
  m4aUrl: string | null;
  /** Same-song video file. Current public songs keep a plain AAC track in here. */
  mp4Url: string | null;
};

export type SunoSong = {
  url: string;
  title: string | null;
  artwork: string | null;
  durationSec: number | null;
  streamUrl: string;
};

type PageResponse = {
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
};

export type SunoDeps = {
  fetchPage?: (url: string) => Promise<PageResponse>;
  /** True when the URL's first bytes are a plain media container (an `ftyp` box). */
  probe?: (url: string) => Promise<boolean>;
};

export function isSunoUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return !!url && SUNO_HOSTS.has(url.hostname.toLowerCase());
}

export function describeSunoLink(raw: string): SunoLink {
  const url = parseUrl(raw);
  if (!url || !SUNO_HOSTS.has(url.hostname.toLowerCase())) return { kind: "other" };
  const parts = url.pathname.split("/").filter(Boolean);
  const [first, second] = parts;
  if (!first) return { kind: "other" };
  if (first === "playlist" || first === "playlists") return { kind: "playlist" };
  if (first === "profile" || first.startsWith("@")) return { kind: "profile" };
  if (first === "song" && second && UUID_RE.test(second)) return { kind: "song", uuid: second.toLowerCase() };
  if (first === "s" && second) return { kind: "short", code: second };
  return { kind: "other" };
}

export function songPageUrl(uuid: string): string {
  return `https://suno.com/song/${uuid.toLowerCase()}`;
}

export function sunoLinkError(kind: "playlist" | "profile" | "short" | "other"): string {
  if (kind === "playlist") return `Suno playlists aren't supported. ${SONG_HINT}`;
  if (kind === "profile") return `Suno profiles aren't supported. ${SONG_HINT}`;
  if (kind === "short") return `That Suno short link didn't resolve to a song. ${SONG_HINT}`;
  return `That Suno link isn't a song. ${SONG_HINT}`;
}

/**
 * Read title, cover, duration, and candidate media URLs out of a public song page.
 * Ignores the silent decoys (og:audio, cdn-o.suno.com/sil-100.mp3) and the retired
 * cdn1.suno.ai/<uuid>.mp3 path, and ignores media that belongs to a different clip.
 */
export function parseSunoPage(html: string, uuid: string): SunoPage {
  const page = html.replace(/\\\//g, "/");
  const id = uuid.toLowerCase();
  return {
    title: readMeta(page, "og:title"),
    artwork: readMeta(page, "og:image"),
    durationSec: readDuration(page, id),
    m4aUrl: clipUrl(page, id),
    mp4Url: page.match(new RegExp(`https://cdn1\\.suno\\.ai/${id}\\.mp4\\b`, "i"))?.[0] ?? null,
  };
}

export async function resolveSunoSong(raw: string, deps: SunoDeps = {}): Promise<SunoSong> {
  const original = describeSunoLink(raw);
  if (original.kind === "playlist" || original.kind === "profile" || original.kind === "other") {
    throw new Error(sunoLinkError(original.kind));
  }

  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const target = original.kind === "song" ? songPageUrl(original.uuid) : raw.trim();
  let page: PageResponse;
  try {
    page = await fetchPage(target);
  } catch {
    throw new Error("Couldn't load that Suno song.");
  }
  if (!page.ok) throw new Error(`Couldn't load that Suno song (${page.status}).`);

  const html = await page.text();
  const resolved = songFromResponse(page.url, html);
  if (resolved.kind !== "song") {
    const failure = original.kind === "short" && resolved.kind === "other" ? "short" : resolved.kind;
    throw new Error(sunoLinkError(failure));
  }

  const parsed = parseSunoPage(html, resolved.uuid);
  const streamUrl = await chooseSunoStream(parsed, deps.probe ?? isPlainContainer);
  return {
    url: songPageUrl(resolved.uuid),
    title: parsed.title,
    artwork: parsed.artwork,
    durationSec: parsed.durationSec,
    streamUrl,
  };
}

/**
 * Prefer the cloudfront clip when its bytes are a real media file. On current public
 * songs that URL is DRM-wrapped (CORS-open, but not an ftyp container), so fall back
 * to the same song's video mp4, which carries a plain AAC track.
 */
export async function chooseSunoStream(page: SunoPage, probe: (url: string) => Promise<boolean>): Promise<string> {
  if (page.m4aUrl && await safeProbe(probe, page.m4aUrl)) return page.m4aUrl;
  if (page.mp4Url && await safeProbe(probe, page.mp4Url)) return page.mp4Url;
  throw new Error("Couldn't find playable audio for this Suno song.");
}

const songCache = new Map<string, { song: SunoSong; expires: number }>();
const inflight = new Map<string, Promise<SunoSong>>();

export async function resolveSunoTracks(url: string): Promise<TrackRef[]> {
  const song = await loadSunoSong(url);
  return [{ url: song.url, title: song.title, artwork: song.artwork }];
}

export async function resolveSunoStreamUrl(url: string): Promise<string> {
  return (await loadSunoSong(url)).streamUrl;
}

async function loadSunoSong(raw: string): Promise<SunoSong> {
  const key = cacheKey(raw);
  const cached = songCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.song;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = resolveSunoSong(raw).then((song) => {
    const entry = { song, expires: Date.now() + SONG_TTL };
    songCache.set(key, entry);
    songCache.set(song.url, entry);
    return song;
  });
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

function cacheKey(raw: string): string {
  const described = describeSunoLink(raw);
  if (described.kind === "song") return songPageUrl(described.uuid);
  return raw.trim();
}

function songFromResponse(finalUrl: string, html: string): SunoLink {
  const fromUrl = describeSunoLink(finalUrl);
  if (fromUrl.kind === "song" || fromUrl.kind === "playlist" || fromUrl.kind === "profile") return fromUrl;
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]
    ?? html.match(/<link[^>]+rel=["']canonical["']/i)?.[0];
  const href = canonical?.match(/href=["']([^"']+)["']/i)?.[1];
  if (href) {
    const fromCanonical = describeSunoLink(href);
    if (fromCanonical.kind === "song") return fromCanonical;
  }
  const ogUrl = readMeta(html, "og:url");
  if (ogUrl) {
    const fromOg = describeSunoLink(ogUrl);
    if (fromOg.kind === "song") return fromOg;
  }
  return fromUrl.kind === "short" ? { kind: "other" } : fromUrl;
}

async function defaultFetchPage(url: string): Promise<PageResponse> {
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
  });
}

export async function isPlainContainer(url: string): Promise<boolean> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Range: "bytes=0-15" },
  });
  if (!(res.ok || res.status === 206) || !res.body) return false;
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    if (!value || value.length < 8) return false;
    return value[4] === 0x66 && value[5] === 0x74 && value[6] === 0x79 && value[7] === 0x70;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function safeProbe(probe: (url: string) => Promise<boolean>, url: string): Promise<boolean> {
  try {
    return await probe(url);
  } catch {
    return false;
  }
}

function clipUrl(html: string, uuid: string): string | null {
  const found = html.match(new RegExp(`https://[a-z0-9]+\\.cloudfront\\.net/\\d+/clip/${uuid}\\.m4a`, "gi")) ?? [];
  return found.find((url) => url.includes(`/1/clip/${uuid}.m4a`)) ?? found[0] ?? null;
}

function readDuration(html: string, uuid: string): number | null {
  let from = 0;
  while (from < html.length) {
    const idx = html.indexOf(uuid, from);
    if (idx < 0) return null;
    const match = html.slice(idx, idx + 2500).match(/\\?"duration\\?"\s*:\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
    from = idx + uuid.length;
  }
  return null;
}

function readMeta(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const prop = tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1];
    if (prop?.toLowerCase() !== key.toLowerCase()) continue;
    const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}
