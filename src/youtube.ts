// YouTube links. There is no audio stream: every listener plays the video through YouTube's
// embedded player, so the server only needs the video id plus a title and thumbnail (oEmbed, no key).
import type { TrackRef } from "./soundcloud";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const ID_RE = /^[\w-]{11}$/;

export type YouTubeDeps = { fetch?: (url: string) => Promise<Response> };

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

export function isYouTubeUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return !!url && HOSTS.has(url.hostname.toLowerCase());
}

/** The 11-character video id, or null for playlists, channels and non-YouTube links. */
export function youtubeVideoId(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const [first, second] = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (url.hostname === "youtu.be") id = first;
  else if (first === "watch") id = url.searchParams.get("v") ?? undefined;
  else if (first === "shorts" || first === "embed" || first === "live") id = second;
  return id && ID_RE.test(id) ? id : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function resolveYouTubeTracks(raw: string, deps: YouTubeDeps = {}): Promise<TrackRef[]> {
  const id = youtubeVideoId(raw);
  if (!id) throw new Error("YouTube playlists aren't supported. Paste a single video link.");
  const url = watchUrl(id);
  const res = await (deps.fetch ?? fetch)(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  if (res.status === 404) throw new Error("Video not found");
  if (res.status === 401 || res.status === 403) throw new Error("This video can't be played outside YouTube");
  if (!res.ok) throw new Error("Couldn't load this YouTube video");
  const meta = (await res.json()) as { title?: string; thumbnail_url?: string };
  return [{ url, title: meta.title ?? null, artwork: meta.thumbnail_url ?? null }];
}
