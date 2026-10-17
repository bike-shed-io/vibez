/**
 * Client for the Suno proxy (`suno-proxy/`), a separate server that downloads
 * songs and streams them to listeners.
 *
 * Vibez never proxies audio itself: it asks the proxy to cache a song and hands
 * listeners the proxy's own URL. The DJ's access token is only ever sent from
 * here, server to server.
 */

export type SunoSongStatus = "queued" | "downloading" | "ready" | "failed";

export type SunoProxySong = {
  id: string;
  status: SunoSongStatus;
  audioUrl: string;
  pageUrl: string;
  title: string | null;
  artwork: string | null;
  durationSec: number | null;
  error: string | null;
};

/** How long a play waits for a download before giving up on the track. */
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 20_000;

export function proxyBaseUrl(): string {
  return (process.env.SUNO_PROXY_URL ?? "").trim().replace(/\/+$/, "");
}

export function isConfigured(): boolean {
  return proxyBaseUrl() !== "";
}

/** True when the proxy accepts this access token. */
export async function checkAccess(token: string): Promise<boolean> {
  const res = await call("GET", "/auth", token);
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`The Suno proxy is not answering (${res.status}).`);
  return true;
}

/**
 * Tells the proxy to cache a song. Returns as soon as the proxy has the song's
 * metadata; the download continues in the background there.
 */
export async function requestSong(token: string, url: string): Promise<SunoProxySong> {
  const res = await call("POST", "/songs", token, { url });
  return readSong(res);
}

export async function songStatus(token: string, id: string): Promise<SunoProxySong> {
  const res = await call("GET", `/songs/${encodeURIComponent(id)}`, token);
  return readSong(res);
}

/**
 * Waits for a song to be downloaded and returns the URL listeners play from.
 * Requesting it again first, rather than only polling, re-downloads a song the
 * proxy has already evicted.
 */
export async function resolveAudioUrl(token: string, url: string, timeoutMs = READY_TIMEOUT_MS): Promise<string> {
  let song = await requestSong(token, url);
  const deadline = Date.now() + timeoutMs;
  while (song.status !== "ready") {
    if (song.status === "failed") throw new Error(song.error ?? "The Suno proxy couldn't download that song.");
    if (Date.now() >= deadline) throw new Error("That Suno song is taking too long to download.");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    song = await songStatus(token, song.id);
  }
  return absolute(song.audioUrl);
}

async function call(method: "GET" | "POST", path: string, token: string, body?: object): Promise<Response> {
  const base = proxyBaseUrl();
  if (!base) throw new Error("Suno isn't set up on this server.");
  try {
    return await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The Suno proxy is not reachable.");
  }
}

async function readSong(res: Response): Promise<SunoProxySong> {
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (res.status === 401) throw new Error("That Suno access token was rejected.");
  if (!res.ok) {
    // The proxy passes link and page complaints through for the DJ to read.
    const message = typeof body?.error === "string" ? body.error : `The Suno proxy failed (${res.status}).`;
    throw new Error(message);
  }
  if (!body || typeof body.id !== "string" || typeof body.audioUrl !== "string") {
    throw new Error("The Suno proxy sent an unexpected response.");
  }
  return {
    id: body.id,
    status: (body.status as SunoSongStatus) ?? "queued",
    audioUrl: body.audioUrl,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
    title: typeof body.title === "string" ? body.title : null,
    artwork: typeof body.artwork === "string" ? body.artwork : null,
    durationSec: typeof body.durationSec === "number" ? body.durationSec : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

/** The proxy may answer with a relative path when it has no public URL configured. */
function absolute(audioUrl: string): string {
  return audioUrl.startsWith("/") ? `${proxyBaseUrl()}${audioUrl}` : audioUrl;
}
