import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createSessionToken, loadAuthConfig, SESSION_COOKIE } from "./auth";
import { channels } from "./channels";
import { flushDirectory, handleClose, handleMessage, handleOpen } from "./ws";
import { createMediaRoutes, configureUploads, playlistSlug, resetUploadSettings, sweepUploads } from "./uploads";

const SECRET = "test-secret";
const ORIGIN = "http://radio.test";

type Fake = { id: string; sent: any[]; closed: boolean };
const open: string[] = [];
let dir = "";
let now = 1_700_000_000_000;

function user(email: string, givenName: string) {
  return { typ: "session" as const, email, name: `${givenName} Example`, givenName, picture: null, exp: now + 60_000 };
}

function tokenFor(account: ReturnType<typeof user>) {
  return createSessionToken(
    { email: account.email, name: account.name, givenName: account.givenName, picture: null },
    SECRET,
    now,
  );
}

function app() {
  const routes = new Hono();
  routes.route("/", createMediaRoutes(loadAuthConfig({ SESSION_SECRET: SECRET, RADIO_URL: ORIGIN }), () => now));
  routes.use("/*", serveStatic({ root: "./public" }));
  return routes;
}

async function connect(id: string, name: string, account: ReturnType<typeof user> | null = null): Promise<Fake> {
  const fake: Fake = { id, sent: [], closed: false };
  handleOpen(
    {
      send(data: string) {
        fake.sent.push(JSON.parse(data));
      },
      close() {
        fake.closed = true;
      },
      readyState: 1,
      raw: undefined,
    } as any,
    id,
    account,
  );
  open.push(id);
  await handleMessage(id, JSON.stringify({ type: "hello", protocol: 2, name }));
  return fake;
}

function last(fake: Fake, type: string) {
  return [...fake.sent].reverse().find((msg) => msg.type === type);
}

async function send(fake: Fake, msg: object) {
  fake.sent.length = 0;
  await handleMessage(fake.id, JSON.stringify(msg));
}

async function goLive(fake: Fake) {
  await send(fake, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [] });
  return last(fake, "channel:state").channel.id as string;
}

function bytes(kind: "mp3" | "m4a" | "wav" | "aac"): ArrayBuffer {
  const data = new Uint8Array(32);
  if (kind === "mp3") data.set([0x49, 0x44, 0x33]);
  if (kind === "wav") data.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  if (kind === "m4a") data.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70], 0);
  if (kind === "aac") data.set([0xff, 0xf1]);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function audioFile(name: string, kind: "mp3" | "m4a" | "wav" | "aac", type: string) {
  return new File([bytes(kind)], name, { type });
}

async function postMedia(
  token: string | null,
  fields: { file?: File; channelId?: string; title?: string; playlist?: string | null },
  auth: "cookie" | "bearer" = "cookie",
) {
  const body = new FormData();
  if (fields.file) body.set("file", fields.file);
  if (fields.channelId !== undefined) body.set("channelId", fields.channelId);
  if (fields.title !== undefined) body.set("title", fields.title);
  if (fields.playlist !== null) body.set("playlist", fields.playlist ?? "Friday Suno");
  const headers: Record<string, string> = {};
  if (token && auth === "cookie") headers.cookie = `${SESSION_COOKIE}=${token}`;
  if (token && auth === "bearer") headers.authorization = `Bearer ${token}`;
  return app().request("/media", { method: "POST", body, headers });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibez-uploads-"));
  now = 1_700_000_000_000;
  configureUploads({
    dir,
    origin: ORIGIN,
    maxBytes: 50 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
    graceMs: 60 * 60 * 1000,
  });
  channels.clear();
});

afterEach(() => {
  for (const id of open.splice(0)) handleClose(id);
  flushDirectory();
  channels.clear();
  resetUploadSettings();
  rmSync(dir, { recursive: true, force: true });
});

describe("audio upload", () => {
  test("a DJ uploads an mp3 and the room plays it from vibez", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const anna = await connect("anna", "Anna");
    const id = await goLive(pat);
    await send(anna, { type: "channel:join", channelId: id });

    const res = await postMedia(tokenFor(account), {
      file: audioFile("Night_Drive.mp3", "mp3", "audio/mpeg"),
      channelId: id,
      title: "  Night Drive  ",
    });
    expect(res.status).toBe(201);
    const saved = await res.json() as { id: string; url: string; title: string; playlist: string; playlistSlug: string };
    expect(saved.title).toBe("Night Drive");
    expect(saved.playlist).toBe("Friday Suno");
    expect(saved.playlistSlug).toBe("friday-suno");
    expect(saved.url).toBe(`${ORIGIN}/media/${saved.playlistSlug}/${saved.id}.mp3`);
    expect(existsSync(join(dir, saved.playlistSlug, `${saved.id}.mp3`))).toBe(true);

    const audio = await app().request(new URL(saved.url).pathname);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(audio.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([...new Uint8Array(bytes("mp3"))]);

    const head = await app().request(new URL(saved.url).pathname, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes("mp3").byteLength));
    expect(await head.arrayBuffer()).toHaveLength(0);

    const partial = await app().request(new URL(saved.url).pathname, { headers: { range: "bytes=0-3" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-3/32");
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([...new Uint8Array(bytes("mp3"))].slice(0, 4));

    await send(pat, { type: "queue:add", url: `https://evil.test/media/${saved.playlistSlug}/${saved.id}.mp3` });
    expect(last(pat, "queue").items).toEqual([
      expect.objectContaining({ url: saved.url, title: "Night Drive", addedBy: "DJ Pat" }),
    ]);

    anna.sent.length = 0;
    await send(pat, { type: "queue:skip" });
    expect(last(pat, "track")).toMatchObject({ url: saved.url, title: "Night Drive", streamUrl: saved.url });
    expect(last(anna, "track").streamUrl).toBe(saved.url);
    expect(channels.get(id)?.streamUrl).toBe(saved.url);
  });

  test("the Mac client can upload with a bearer token and play the file directly", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const res = await postMedia(tokenFor(account), {
      file: audioFile("song.mp3", "mp3", "application/octet-stream"),
      channelId: id,
    }, "bearer");
    expect(res.status).toBe(201);
    const saved = await res.json() as { url: string; title: string };
    expect(saved.title).toBe("song");

    await send(pat, { type: "dj:play", url: saved.url });
    expect(last(pat, "track")).toMatchObject({ url: saved.url, streamUrl: saved.url, title: "song" });
  });

  test("filename becomes the title when one is not typed", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const res = await postMedia(tokenFor(account), {
      file: audioFile("Café_Hour.MP3", "mp3", "audio/mpeg"),
      channelId: id,
      title: "   ",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("Café Hour");
  });

  test("m4a, wav, and aac uploads are accepted", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const cases = [
      ["tune.m4a", "m4a", "audio/mp4", "audio/mp4"],
      ["tune.wav", "wav", "audio/wav", "audio/wav"],
      ["tune.aac", "aac", "audio/aac", "audio/aac"],
    ] as const;
    for (const [name, kind, type, mime] of cases) {
      const res = await postMedia(tokenFor(account), { file: audioFile(name, kind, type), channelId: id });
      expect(res.status).toBe(201);
      const saved = await res.json() as { url: string };
      const audio = await app().request(new URL(saved.url).pathname);
      expect(audio.headers.get("content-type")).toBe(mime);
    }
  });

  test("anonymous, outsiders, and untrusted listeners cannot upload", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const file = audioFile("song.mp3", "mp3", "audio/mpeg");

    const anon = await postMedia(null, { file, channelId: id });
    expect(anon.status).toBe(401);
    expect((await anon.json()).error).toBe("Sign in to upload tracks");

    const samAccount = user("sam@example.com", "Sam");
    await connect("sam", "Sam", samAccount);
    const outsider = await postMedia(tokenFor(samAccount), { file, channelId: id });
    expect(outsider.status).toBe(403);
    expect((await outsider.json()).error).toBe("Join the room before uploading");

    const maxAccount = user("max@example.com", "Max");
    const max = await connect("max", "Max", maxAccount);
    await send(max, { type: "channel:join", channelId: id });
    await send(pat, { type: "live:queue-access", trustedOnly: true });
    const blocked = await postMedia(tokenFor(maxAccount), { file, channelId: id });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("Only trusted DJs can add tracks here");
    expect(existsSync(dir) && (await Array.fromAsync(new Bun.Glob("*.mp3").scan({ cwd: dir }))).length).toBe(0);
  });

  test("rejects the wrong type, a fake mp3, a missing file, and an ended room", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const token = tokenFor(account);

    const html = await postMedia(token, {
      file: new File(["<html>not audio</html>"], "song.mp3", { type: "audio/mpeg" }),
      channelId: id,
    });
    expect(html.status).toBe(400);
    expect((await html.json()).error).toBe("That file doesn't look like a mp3");

    const wrongKind = await postMedia(token, {
      file: new File([bytes("mp3")], "song.wav", { type: "audio/wav" }),
      channelId: id,
    });
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()).error).toBe("That file doesn't look like a wav");

    const text = await postMedia(token, {
      file: new File([bytes("mp3")], "notes.txt", { type: "audio/mpeg" }),
      channelId: id,
    });
    expect(text.status).toBe(400);
    expect((await text.json()).error).toBe("Upload an mp3, m4a, wav, or aac file");

    const missing = await postMedia(token, { channelId: id });
    expect(missing.status).toBe(400);

    const ended = await postMedia(token, { file: audioFile("song.mp3", "mp3", "audio/mpeg"), channelId: "gone" });
    expect(ended.status).toBe(404);
  });

  test("enforces size and storage limits", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    configureUploads({ maxBytes: 8 });
    const tooBig = await postMedia(tokenFor(account), {
      file: audioFile("song.mp3", "mp3", "audio/mpeg"),
      channelId: id,
    });
    expect(tooBig.status).toBe(413);

    configureUploads({ maxBytes: 50 * 1024 * 1024, maxTotalBytes: 40 });
    const first = await postMedia(tokenFor(account), { file: audioFile("a.mp3", "mp3", "audio/mpeg"), channelId: id });
    expect(first.status).toBe(201);
    const second = await postMedia(tokenFor(account), { file: audioFile("b.mp3", "mp3", "audio/mpeg"), channelId: id });
    expect(second.status).toBe(507);
    expect((await second.json()).error).toBe("Upload storage is full");
  });

  test("missing and mismatched uploads are not queued or served", async () => {
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const missing = `${ORIGIN}/media/friday-suno/00000000-0000-4000-8000-000000000001.mp3`;
    await send(pat, { type: "queue:add", url: missing });
    expect(pat.sent).toEqual([{ type: "error", message: "That upload is no longer available" }]);
    expect(channels.get(id)?.queue).toEqual([]);

    const res = await postMedia(tokenFor(account), {
      file: audioFile("song.mp3", "mp3", "audio/mpeg"),
      channelId: id,
    });
    const saved = await res.json() as { id: string; playlistSlug: string };
    expect((await app().request(`/media/${saved.playlistSlug}/${saved.id}.wav`)).status).toBe(404);
    expect((await app().request(`/media/other-set/${saved.id}.mp3`)).status).toBe(404);
    expect((await app().request(`/media/${saved.id}.mp3`)).status).toBe(404);
    expect((await app().request("/media/friday-suno/not-a-uuid.mp3")).status).toBe(404);
    expect((await app().request("/media/%2e%2e/%2e%2e/passwd")).status).toBe(404);
    const past = await app().request(`/media/${saved.playlistSlug}/${saved.id}.mp3`, { headers: { range: "bytes=100-120" } });
    expect(past.status).toBe(416);
  });

  test("sweep keeps queued audio and deletes abandoned files after the grace period", async () => {
    configureUploads({ graceMs: 1_000 });
    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const queued = await postMedia(tokenFor(account), {
      file: audioFile("queued.mp3", "mp3", "audio/mpeg"),
      channelId: id,
      title: "Queued",
    });
    const queuedBody = await queued.json() as { id: string; url: string };
    await send(pat, { type: "queue:add", url: queuedBody.url });

    now += 5_000;
    const abandoned = await postMedia(tokenFor(account), {
      file: audioFile("abandoned.mp3", "mp3", "audio/mpeg"),
      channelId: id,
      title: "Abandoned",
    });
    const abandonedBody = await abandoned.json() as { id: string; url: string };

    writeFileSync(join(dir, "keep.txt"), "leave unexpected files alone");
    expect(sweepUploads(now, [queuedBody.url])).toBe(0);
    expect(existsSync(join(dir, "friday-suno", `${queuedBody.id}.mp3`))).toBe(true);
    expect(existsSync(join(dir, "friday-suno", `${abandonedBody.id}.mp3`))).toBe(true);

    expect(sweepUploads(now + 1_001, [queuedBody.url])).toBe(1);
    expect(existsSync(join(dir, "friday-suno", `${queuedBody.id}.mp3`))).toBe(true);
    expect(existsSync(join(dir, "friday-suno", `${queuedBody.id}.json`))).toBe(true);
    expect(existsSync(join(dir, "friday-suno", `${abandonedBody.id}.mp3`))).toBe(false);
    expect(existsSync(join(dir, "friday-suno", `${abandonedBody.id}.json`))).toBe(false);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);

    expect(sweepUploads(now + 1_001, [])).toBe(1);
    expect(existsSync(join(dir, "friday-suno", `${queuedBody.id}.mp3`))).toBe(false);
    expect(existsSync(join(dir, "friday-suno"))).toBe(false);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  test("a playlist is a folder, and a bad name is refused", async () => {
    expect(playlistSlug("Friday Suno")).toBe("friday-suno");
    expect(playlistSlug("  Café   Hour  ")).toBe("cafe-hour");
    expect(playlistSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(playlistSlug("!!!")).toBe(null);
    expect(playlistSlug("")).toBe(null);
    expect(playlistSlug("a".repeat(80))).toBe("a".repeat(40));

    const account = user("pat@example.com", "Pat");
    const pat = await connect("pat", "Pat", account);
    const id = await goLive(pat);
    const token = tokenFor(account);

    const first = await postMedia(token, { file: audioFile("one.mp3", "mp3", "audio/mpeg"), channelId: id });
    const second = await postMedia(token, { file: audioFile("two.mp3", "mp3", "audio/mpeg"), channelId: id, playlist: "Friday   Suno" });
    const firstBody = await first.json() as { id: string; playlistSlug: string };
    const secondBody = await second.json() as { id: string; playlist: string; playlistSlug: string };
    expect(firstBody.playlistSlug).toBe("friday-suno");
    expect(secondBody.playlist).toBe("Friday Suno");
    expect(secondBody.playlistSlug).toBe(firstBody.playlistSlug);
    expect(existsSync(join(dir, "friday-suno", `${firstBody.id}.mp3`))).toBe(true);
    expect(existsSync(join(dir, "friday-suno", `${secondBody.id}.mp3`))).toBe(true);

    const slipped = await postMedia(token, {
      file: audioFile("four.mp3", "mp3", "audio/mpeg"),
      channelId: id,
      playlist: "../../etc/passwd",
    });
    expect(slipped.status).toBe(201);
    const slippedBody = await slipped.json() as { id: string; playlist: string; playlistSlug: string };
    expect(slippedBody.playlist).toBe("../../etc/passwd");
    expect(slippedBody.playlistSlug).toBe("etc-passwd");
    const stored = realpathSync(join(dir, "etc-passwd", `${slippedBody.id}.mp3`));
    expect(stored.startsWith(`${realpathSync(dir)}/`)).toBe(true);

    const blank = await postMedia(token, { file: audioFile("five.mp3", "mp3", "audio/mpeg"), channelId: id, playlist: null });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe("Name the playlist these tracks belong to");
    const marks = await postMedia(token, { file: audioFile("six.mp3", "mp3", "audio/mpeg"), channelId: id, playlist: "!!!" });
    expect(marks.status).toBe(400);
    expect((await marks.json()).error).toBe("Name the playlist these tracks belong to");

    expect((await app().request(`/media/${firstBody.id}.mp3`)).status).toBe(404);

    configureUploads({ graceMs: 1_000 });
    now += 5_000;
    const other = await postMedia(token, {
      file: audioFile("three.mp3", "mp3", "audio/mpeg"),
      channelId: id,
      playlist: "Late Night",
    });
    const otherBody = await other.json() as { id: string; playlistSlug: string };
    expect(otherBody.playlistSlug).toBe("late-night");
    expect((await app().request(`/media/friday-suno/${otherBody.id}.mp3`)).status).toBe(404);

    expect(sweepUploads(now, [])).toBe(3);
    expect(existsSync(join(dir, "friday-suno"))).toBe(false);
    expect(existsSync(join(dir, "etc-passwd"))).toBe(false);
    expect(existsSync(join(dir, "late-night", `${otherBody.id}.mp3`))).toBe(true);
    expect(sweepUploads(now + 1_001, [])).toBe(1);
    expect(existsSync(join(dir, "late-night"))).toBe(false);
  });
});
