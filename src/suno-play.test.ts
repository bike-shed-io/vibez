import { afterEach, describe, expect, test } from "bun:test";
import { channels } from "./channels";
import { flushDirectory, handleClose, handleMessage, handleOpen } from "./ws";

const UUID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981";
const SHORT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Fake = { id: string; sent: any[]; closed: boolean };
const open: string[] = [];
const originalFetch = globalThis.fetch;

function user(email: string, givenName: string) {
  return { typ: "session" as const, email, name: `${givenName} Example`, givenName, picture: null, exp: Date.now() + 60_000 };
}

function page(uuid: string): string {
  return `<!doctype html>
    <link rel="canonical" href="https://suno.com/song/${uuid}">
    <meta property="og:title" content="Raised on Rewind &amp; Friends" />
    <meta property="og:image" content="https://cdn2.suno.ai/${uuid}_cover.jpeg" />
    <meta property="og:audio" content="https://cdn-o.suno.com/sil-100.mp3" />
    \\"audio_url\\":\\"https://cdn1.suno.ai/${uuid}.mp3\\"
    \\"video_url\\":\\"https://cdn1.suno.ai/${uuid}.mp4\\"
    \\"media_urls\\":[{\\"url\\":\\"https://d2lwuy8qc234o3.cloudfront.net/1/clip/${uuid}.m4a\\",\\"content_type\\":\\"m4a-opus\\"}]
    \\"id\\":\\"${uuid}\\",\\"metadata\\":{\\"duration\\":220.64}`;
}

function ftyp(): Response {
  const bytes = new Uint8Array(16);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
  return new Response(bytes, { status: 206, headers: { "content-type": "video/mp4" } });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetch(): string[] {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    fetched.push(url);
    if (url.includes("soundcloud")) return new Response("soundcloud", { status: 500 });
    if (url === "https://suno.com/s/Ab12") return new Response(page(SHORT_UUID), { status: 200 });
    const song = url.match(/suno\.com\/song\/([0-9a-f-]{36})/i);
    if (song) return new Response(page(song[1].toLowerCase()), { status: 200 });
    if (url.endsWith(".mp4")) return ftyp();
    if (url.endsWith(".m4a")) return new Response(new Uint8Array(16), { status: 206 });
    return originalFetch(input, init);
  }) as typeof fetch;
  return fetched;
}

async function connect(id: string): Promise<Fake> {
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
    user("pat@example.com", "Pat"),
  );
  open.push(id);
  await handleMessage(id, JSON.stringify({ type: "hello", protocol: 3, name: "Pat" }));
  return fake;
}

function last(fake: Fake, type: string) {
  return [...fake.sent].reverse().find((msg) => msg.type === type);
}

async function send(fake: Fake, msg: object) {
  fake.sent.length = 0;
  await handleMessage(fake.id, JSON.stringify(msg));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const id of open.splice(0)) handleClose(id);
  flushDirectory();
  channels.clear();
});

describe("Suno links through add and play", () => {
  test("DJ play and the queue use the Suno stream, not SoundCloud", async () => {
    const fetched = installFetch();
    const pat = await connect("suno-dj");
    await send(pat, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [] });
    const channel = channels.get(last(pat, "channel:state").channel.id);
    if (!channel) throw new Error("expected a live channel");

    await send(pat, { type: "dj:play", url: `https://www.suno.com/song/${UUID.toUpperCase()}/?si=1` });
    const track = last(pat, "track");
    expect(track).toMatchObject({
      url: `https://suno.com/song/${UUID}`,
      title: "Raised on Rewind & Friends",
      streamUrl: `https://cdn1.suno.ai/${UUID}.mp4`,
    });
    expect(channel.trackUrl).toBe(`https://suno.com/song/${UUID}`);
    expect(channel.streamUrl).toBe(`https://cdn1.suno.ai/${UUID}.mp4`);
    expect(channel.isPlaying).toBe(true);

    await send(pat, { type: "queue:add", url: "https://suno.com/s/Ab12" });
    const queued = last(pat, "queue").items;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      url: `https://suno.com/song/${SHORT_UUID}`,
      title: "Raised on Rewind & Friends",
    });

    expect(fetched.some((url) => url.includes("soundcloud"))).toBe(false);
  });

  test("a Suno playlist is rejected before SoundCloud is asked", async () => {
    const fetched = installFetch();
    const pat = await connect("suno-queue");
    await send(pat, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [] });

    await send(pat, { type: "queue:add", url: "https://suno.com/playlist/chill" });
    expect(last(pat, "error").message).toContain("Suno playlists aren't supported.");
    expect(fetched.some((url) => url.includes("soundcloud"))).toBe(false);
  });
});
