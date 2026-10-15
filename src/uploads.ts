import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { sessionFromHeaders, type AuthConfig, type SessionUser } from "./auth";
import { channels, rolesFor, type Channel } from "./channels";
import type { TrackRef } from "./soundcloud";

// DJs upload audio the room can play when a link has no public stream (new Suno songs).
// Files live in .cache/uploads, which is the deploy volume, so a restart can keep playing them.
// Anything not in a room's queue or now-playing slot is deleted after UPLOAD_GRACE_MS.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_STORE_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

const AUDIO_EXTS = ["mp3", "m4a", "wav", "aac"] as const;
type AudioExt = (typeof AUDIO_EXTS)[number];

const SERVE_MIME: Record<AudioExt, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
};

const ACCEPTED_MIME: Record<AudioExt, Set<string>> = {
  mp3: new Set(["audio/mpeg", "audio/mp3", "application/octet-stream", ""]),
  m4a: new Set(["audio/mp4", "audio/x-m4a", "audio/m4a", "video/mp4", "application/octet-stream", ""]),
  wav: new Set(["audio/wav", "audio/wave", "audio/x-wav", "application/octet-stream", ""]),
  aac: new Set(["audio/aac", "audio/x-aac", "audio/aacp", "application/octet-stream", ""]),
};

type UploadRecord = {
  id: string;
  ext: AudioExt;
  mime: string;
  title: string;
  ep: string;
  epSlug: string;
  bytes: number;
  uploadedBy: string;
  createdAt: number;
};

type UploadSettings = {
  dir: string;
  origin: string;
  maxBytes: number;
  maxTotalBytes: number;
  graceMs: number;
};

export class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function defaultSettings(): UploadSettings {
  return {
    dir: join(import.meta.dir, "..", ".cache", "uploads"),
    origin: (process.env.RADIO_URL ?? "http://localhost:3005").replace(/\/$/, ""),
    maxBytes: MAX_UPLOAD_BYTES,
    maxTotalBytes: MAX_UPLOAD_STORE_BYTES,
    graceMs: UPLOAD_GRACE_MS,
  };
}

let settings = defaultSettings();

export function configureUploads(over: Partial<UploadSettings>) {
  settings = { ...settings, ...over };
  settings.origin = settings.origin.replace(/\/$/, "");
}

export function resetUploadSettings() {
  settings = defaultSettings();
}

const EP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MEDIA_PATH = /^\/media\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp3|m4a|wav|aac)$/i;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EP_REQUIRED = "Name the Vibez EP these tracks belong to";

export function epSlug(value: unknown): string | null {
  const display = cleanEpName(value);
  if (!display) return null;
  const folded = display.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/-+$/g, "");
  return EP_SLUG.test(slug) ? slug : null;
}

export function mediaIdFromUrl(raw: string): { epSlug: string; id: string; ext: AudioExt } | null {
  const trimmed = raw.trim();
  let pathname = "";
  if (trimmed.startsWith("/")) {
    pathname = trimmed.split("?")[0] ?? "";
  } else {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }
  const match = MEDIA_PATH.exec(pathname);
  if (!match) return null;
  return { epSlug: match[1], id: match[2].toLowerCase(), ext: match[3].toLowerCase() as AudioExt };
}

export function isUploadUrl(raw: string): boolean {
  return mediaIdFromUrl(raw) !== null;
}

function extensionOf(name: string): AudioExt | null {
  const base = name.split(/[/\\]/).pop() ?? "";
  const match = /\.([a-z0-9]+)$/i.exec(base);
  const ext = match?.[1]?.toLowerCase();
  return AUDIO_EXTS.find((allowed) => allowed === ext) ?? null;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function cleanEpName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function cleanUploadTitle(value: unknown, fallback: string): string {
  const chosen = typeof value === "string" ? value : "";
  const raw = chosen.trim() ? chosen : fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || "Track";
}

function titleFromFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const stem = base.replace(/\.(mp3|m4a|wav|aac)$/i, "").replace(/_+/g, " ");
  return cleanUploadTitle(stem, "Track");
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function looksLikeAudio(ext: AudioExt, bytes: Uint8Array): boolean {
  if (ext === "mp3") {
    if (asciiAt(bytes, 0, "ID3")) return true;
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  }
  if (ext === "wav") return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
  if (ext === "m4a") return asciiAt(bytes, 4, "ftyp");
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
}

function audioPath(record: Pick<UploadRecord, "epSlug" | "id" | "ext">): string {
  return join(settings.dir, record.epSlug, `${record.id}.${record.ext}`);
}

function canonicalUrl(record: Pick<UploadRecord, "epSlug" | "id" | "ext">): string {
  return `${settings.origin}/media/${record.epSlug}/${record.id}.${record.ext}`;
}

function epDirs(): string[] {
  if (!existsSync(settings.dir)) return [];
  return readdirSync(settings.dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && EP_SLUG.test(entry.name))
    .map((entry) => entry.name);
}

function readRecord(slug: string, id: string): UploadRecord | null {
  if (!EP_SLUG.test(slug) || !ID_PATTERN.test(id)) return null;
  const path = join(settings.dir, slug, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UploadRecord>;
    if (raw.id !== id || raw.epSlug !== slug || typeof raw.ext !== "string") return null;
    if (!AUDIO_EXTS.includes(raw.ext as AudioExt)) return null;
    if (typeof raw.mime !== "string" || typeof raw.title !== "string" || typeof raw.ep !== "string") return null;
    if (typeof raw.bytes !== "number" || typeof raw.createdAt !== "number") return null;
    if (typeof raw.uploadedBy !== "string") return null;
    return raw as UploadRecord;
  } catch {
    return null;
  }
}

function storeBytes(): number {
  let total = 0;
  for (const slug of epDirs()) {
    for (const name of readdirSync(join(settings.dir, slug))) {
      if (!name.endsWith(".json")) continue;
      const record = readRecord(slug, name.slice(0, -".json".length));
      if (record) total += record.bytes;
    }
  }
  return total;
}

function unlinkQuiet(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export async function saveUpload(input: {
  file: File;
  title: unknown;
  ep: unknown;
  uploadedBy: string;
  now: number;
}): Promise<{ id: string; url: string; title: string; ep: string; epSlug: string }> {
  const ep = cleanEpName(input.ep);
  const slug = epSlug(ep);
  if (!slug) throw new UploadError(EP_REQUIRED, 400);

  const ext = extensionOf(input.file.name);
  if (!ext) throw new UploadError("Upload an mp3, m4a, wav, or aac file", 400);
  const mime = (input.file.type || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_MIME[ext].has(mime)) throw new UploadError("Upload an mp3, m4a, wav, or aac file", 400);
  if (input.file.size <= 0) throw new UploadError("That file is empty", 400);
  if (input.file.size > settings.maxBytes) {
    throw new UploadError(`File is too large (max ${sizeLabel(settings.maxBytes)})`, 413);
  }

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  if (!looksLikeAudio(ext, bytes)) throw new UploadError(`That file doesn't look like a ${ext}`, 400);

  const folder = join(settings.dir, slug);
  mkdirSync(folder, { recursive: true });
  if (storeBytes() + bytes.byteLength > settings.maxTotalBytes) {
    throw new UploadError("Upload storage is full", 507);
  }

  const id = crypto.randomUUID();
  const title = cleanUploadTitle(
    input.title,
    titleFromFilename(input.file.name),
  );
  const record: UploadRecord = {
    id,
    ext,
    mime: SERVE_MIME[ext],
    title,
    ep,
    epSlug: slug,
    bytes: bytes.byteLength,
    uploadedBy: input.uploadedBy.toLowerCase(),
    createdAt: input.now,
  };
  const finalPath = audioPath(record);
  const tmpPath = join(folder, `${id}.upload.tmp`);
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, finalPath);
  writeFileSync(join(folder, `${id}.json`), JSON.stringify(record));
  console.log(`[uploads] stored ${slug}/${id}.${ext} (${record.bytes} bytes)`);
  return { id, url: canonicalUrl(record), title, ep, epSlug: slug };
}

export function resolveUploadTrack(raw: string): TrackRef {
  const parsed = mediaIdFromUrl(raw);
  if (!parsed) throw new Error("Upload an mp3, m4a, wav, or aac file");
  const record = readRecord(parsed.epSlug, parsed.id);
  if (!record || record.ext !== parsed.ext || !existsSync(audioPath(record))) {
    throw new Error("That upload is no longer available");
  }
  return { url: canonicalUrl(record), title: record.title, artwork: null };
}

export function resolveUploadStreamUrl(raw: string): string {
  return resolveUploadTrack(raw).url;
}

export type EpTrack = {
  id: string;
  url: string;
  title: string;
};

export type EpSummary = {
  name: string;
  slug: string;
  tracks: EpTrack[];
};

export type QueuedUpload = {
  id: string;
  url: string;
  title: string | null;
  artwork: string | null;
  addedBy: string;
};

export type UploadHooks = {
  onTrackQueued?: (channelId: string, item: QueuedUpload) => void;
};

function recordsIn(slug: string): UploadRecord[] {
  if (!EP_SLUG.test(slug)) return [];
  const folder = join(settings.dir, slug);
  if (!existsSync(folder)) return [];
  const records: UploadRecord[] = [];
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(slug, name.slice(0, -".json".length));
    if (record && existsSync(audioPath(record))) records.push(record);
  }
  return records;
}

export function listEps(): EpSummary[] {
  const eps: EpSummary[] = [];
  for (const slug of epDirs()) {
    const records = recordsIn(slug);
    if (records.length === 0) continue;
    const latest = records.reduce((best, record) => (record.createdAt >= best.createdAt ? record : best));
    const tracks = records
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => ({ id: record.id, url: canonicalUrl(record), title: record.title }));
    eps.push({ name: latest.ep, slug, tracks });
  }
  eps.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return eps;
}

export function epTracks(slug: string): EpTrack[] {
  if (epSlug(slug) !== slug) return [];
  return listEps().find((ep) => ep.slug === slug)?.tracks ?? [];
}

export function orderEpPlayback(
  tracks: EpTrack[],
  trackId?: string,
  random: () => number = Math.random,
): { first: EpTrack; rest: EpTrack[] } {
  if (tracks.length === 0) throw new UploadError("That Vibez EP has no songs", 404);
  const shuffle = <T,>(items: T[]): T[] => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.max(0, Math.min(i, Math.floor(random() * (i + 1))));
      const swapped = copy[i];
      copy[i] = copy[j];
      copy[j] = swapped;
    }
    return copy;
  };
  if (trackId) {
    const first = tracks.find((track) => track.id === trackId);
    if (!first) throw new UploadError("That song isn't on this Vibez EP", 404);
    return { first, rest: shuffle(tracks.filter((track) => track.id !== trackId)) };
  }
  const shuffled = shuffle(tracks);
  const first = shuffled[0];
  if (!first) throw new UploadError("That Vibez EP has no songs", 404);
  return { first, rest: shuffled.slice(1) };
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function removeEmptyEp(slug: string) {
  try {
    rmdirSync(join(settings.dir, slug));
  } catch {
    // still holding tracks, or already gone
  }
}

export function sweepUploads(now: number, liveUrls: Iterable<string>): number {
  const live = new Set<string>();
  for (const url of liveUrls) {
    const parsed = mediaIdFromUrl(url);
    if (parsed) live.add(parsed.id);
  }

  const removed = new Set<string>();
  for (const slug of epDirs()) {
    const folder = join(settings.dir, slug);
    for (const name of readdirSync(folder)) {
      const audio = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:json|mp3|m4a|wav|aac)$/i.exec(name);
      const tmp = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.upload\.tmp$/i.exec(name);
      const match = audio ?? tmp;
      if (!match) continue;
      const id = match[1].toLowerCase();
      if (live.has(id) || removed.has(`${slug}/${id}`)) continue;
      const record = readRecord(slug, id);
      const createdAt = record?.createdAt ?? fileMtime(join(folder, name));
      if (createdAt + settings.graceMs > now) continue;
      if (record) unlinkQuiet(audioPath(record));
      for (const ext of AUDIO_EXTS) unlinkQuiet(join(folder, `${id}.${ext}`));
      unlinkQuiet(join(folder, `${id}.json`));
      unlinkQuiet(join(folder, `${id}.upload.tmp`));
      removed.add(`${slug}/${id}`);
    }
    removeEmptyEp(slug);
  }
  if (removed.size > 0) console.log(`[uploads] removed ${removed.size} unused file(s)`);
  return removed.size;
}

export function mediaResponse(ep: string, name: string, request: Request): Response | null {
  const parsed = mediaIdFromUrl(`/media/${ep}/${name}`);
  if (!parsed) return null;
  const record = readRecord(parsed.epSlug, parsed.id);
  if (!record || record.ext !== parsed.ext) return null;
  const path = audioPath(record);
  if (!existsSync(path)) return null;
  const file = Bun.file(path);
  const size = file.size;
  if (!Number.isFinite(size) || size <= 0) return null;

  const headers: Record<string, string> = {
    "Content-Type": record.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };

  const range = request.headers.get("range");
  const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;
  if (range && !match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    const clampedEnd = Math.min(end, size - 1);
    return new Response(file.slice(start, clampedEnd + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${clampedEnd}/${size}`,
        "Content-Length": String(clampedEnd - start + 1),
      },
    });
  }

  return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
}

function isMember(ch: Channel, email: string): boolean {
  for (const member of ch.members.values()) {
    if (member.email === email) return true;
  }
  return false;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorizeQueue(
  authConfig: AuthConfig,
  now: number,
  headers: { cookie?: string | null; authorization?: string | null },
  channelId: string,
): { user: SessionUser; channel: Channel } | Response {
  const user = sessionFromHeaders(headers, authConfig, now);
  if (!user) return jsonError("Sign in to upload tracks", 401);
  const channelKey = channelId.trim();
  if (!channelKey) return jsonError("Join a room before uploading", 400);
  const channel = channels.get(channelKey);
  if (!channel) return jsonError("That channel ended", 404);
  const email = user.email.toLowerCase();
  if (!isMember(channel, email)) return jsonError("Join the room before uploading", 403);
  if (!rolesFor(channel, email).canQueue) return jsonError("Only trusted DJs can add tracks here", 403);
  return { user, channel };
}

export function createMediaRoutes(authConfig: AuthConfig, now: () => number = Date.now, hooks: UploadHooks = {}) {
  const routes = new Hono();

  routes.post("/media", async (c) => {
    const user = sessionFromHeaders(
      { cookie: c.req.header("cookie"), authorization: c.req.header("authorization") },
      authConfig,
      now(),
    );
    if (!user) return jsonError("Sign in to upload tracks", 401);

    const length = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(length) && length > settings.maxBytes + 256 * 1024) {
      return jsonError(`File is too large (max ${sizeLabel(settings.maxBytes)})`, 413);
    }

    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return jsonError("Could not read upload", 400);
    }

    const channelKey = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!channelKey) return jsonError("Join a room before uploading", 400);
    const ch = channels.get(channelKey);
    if (!ch) return jsonError("That channel ended", 404);
    const email = user.email.toLowerCase();
    if (!isMember(ch, email)) return jsonError("Join the room before uploading", 403);
    if (!rolesFor(ch, email).canQueue) return jsonError("Only trusted DJs can add tracks here", 403);

    const file = body.file;
    if (!(file instanceof File)) return jsonError("Choose an audio file", 400);
    if (!epSlug(body.ep)) return jsonError(EP_REQUIRED, 400);

    try {
      const saved = await saveUpload({
        file,
        title: body.title,
        ep: body.ep,
        uploadedBy: email,
        now: now(),
      });
      const playing = mediaIdFromUrl(ch.trackUrl ?? "")?.epSlug === saved.epSlug;
      if (playing) {
        hooks.onTrackQueued?.(ch.id, {
          id: crypto.randomUUID(),
          url: saved.url,
          title: saved.title,
          artwork: null,
          addedBy: user.givenName || user.name,
        });
      }
      return c.json({ ...saved, queued: playing }, 201);
    } catch (err) {
      if (err instanceof UploadError) return jsonError(err.message, err.status);
      console.error("[uploads] save failed:", err);
      return jsonError("Upload failed", 400);
    }
  });

  routes.get("/eps", (c) => {
    const allowed = authorizeQueue(
      authConfig,
      now(),
      { cookie: c.req.header("cookie"), authorization: c.req.header("authorization") },
      c.req.query("channelId") ?? "",
    );
    if (allowed instanceof Response) return allowed;
    return c.json({ eps: listEps() });
  });

  routes.on(["GET", "HEAD"], "/media/:ep/:name", (c) => {
    const response = mediaResponse(c.req.param("ep"), c.req.param("name"), c.req.raw);
    if (!response) return c.notFound();
    if (c.req.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
    return response;
  });

  return routes;
}
