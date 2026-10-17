/**
 * Suno link parsing only.
 *
 * Fetching a song page, choosing a playable file and downloading it belong to the
 * Suno proxy (`suno-proxy/`), which hands listeners a file instead of a Suno CDN
 * URL. Vibez keeps this much so a DJ hears about a bad link before a round-trip.
 */

const SUNO_HOSTS = new Set(["suno.com", "www.suno.com", "app.suno.ai"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SONG_HINT = "Paste a suno.com/song/… or suno.com/s/… link.";

export type SunoLink =
  | { kind: "song"; uuid: string }
  | { kind: "short"; code: string }
  | { kind: "playlist" }
  | { kind: "profile" }
  | { kind: "other" };

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

/** The song id behind a track URL, or null when the link isn't a song page. */
export function sunoSongId(raw: string): string | null {
  const link = describeSunoLink(raw);
  return link.kind === "song" ? link.uuid : null;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}
