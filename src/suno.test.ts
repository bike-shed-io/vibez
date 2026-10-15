import { describe, expect, test } from "bun:test";
import {
  chooseSunoStream,
  describeSunoLink,
  isSunoUrl,
  parseSunoPage,
  resolveSunoSong,
  type SunoPage,
} from "./suno";

const UUID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981";
const OTHER = "4e7a04bb-bd77-4b39-b6dc-c0cdfa5d2860";

function page(uuid = UUID): string {
  return `<!doctype html>
    <meta property="og:audio" content="https://cdn-o.suno.com/sil-100.mp3" />
    <meta property="og:title" content="Raised on Rewind &amp; Friends" />
    <meta property="og:image" content="https://cdn2.suno.ai/${uuid}_cover.jpeg" />
    <audio id="silent-audio" src="https://cdn-o.suno.com/sil-100.mp3"></audio>
    \\"audio_url\\":\\"https://cdn1.suno.ai/${uuid}.mp3\\"
    \\"video_url\\":\\"https://cdn1.suno.ai/${uuid}.mp4\\"
    \\"media_urls\\":[{\\"url\\":\\"https://d2lwuy8qc234o3.cloudfront.net/1/clip/${uuid}.m4a\\",\\"content_type\\":\\"m4a-opus\\"}]
    \\"id\\":\\"${uuid}\\",\\"metadata\\":{\\"duration\\":220.64}
    \\"url\\":\\"https://d2lwuy8qc234o3.cloudfront.net/2/clip/${OTHER}.m4a\\"
    \\"video_url\\":\\"https://cdn1.suno.ai/${OTHER}.mp4\\"`;
}

describe("Suno links", () => {
  test("accepts song and short links, including www and a trailing query", () => {
    expect(describeSunoLink(`https://suno.com/song/${UUID}`)).toEqual({ kind: "song", uuid: UUID });
    expect(describeSunoLink(`https://www.suno.com/song/${UUID.toUpperCase()}/?si=1`)).toEqual({ kind: "song", uuid: UUID });
    expect(describeSunoLink(`https://app.suno.ai/song/${UUID}`)).toEqual({ kind: "song", uuid: UUID });
    expect(describeSunoLink("https://suno.com/s/Ab12")).toEqual({ kind: "short", code: "Ab12" });
    expect(isSunoUrl("https://suno.com/song/x")).toBe(true);
    expect(isSunoUrl("https://soundcloud.com/artist/track")).toBe(false);
  });

  test("rejects playlists and profiles before treating them as songs", () => {
    expect(describeSunoLink("https://suno.com/playlist/chill")).toEqual({ kind: "playlist" });
    expect(describeSunoLink("https://suno.com/playlists/chill")).toEqual({ kind: "playlist" });
    expect(describeSunoLink("https://suno.com/@necthan")).toEqual({ kind: "profile" });
    expect(describeSunoLink("https://www.suno.com/profile/necthan")).toEqual({ kind: "profile" });
    expect(describeSunoLink("https://suno.com/pricing")).toEqual({ kind: "other" });
  });
});

describe("parseSunoPage", () => {
  test("reads title, cover, and duration, and skips silent decoys and other clips", () => {
    const parsed = parseSunoPage(page(), UUID);
    expect(parsed.title).toBe("Raised on Rewind & Friends");
    expect(parsed.artwork).toBe(`https://cdn2.suno.ai/${UUID}_cover.jpeg`);
    expect(parsed.durationSec).toBe(220.64);
    expect(parsed.m4aUrl).toBe(`https://d2lwuy8qc234o3.cloudfront.net/1/clip/${UUID}.m4a`);
    expect(parsed.mp4Url).toBe(`https://cdn1.suno.ai/${UUID}.mp4`);
    expect(parsed.m4aUrl).not.toContain(OTHER);
    expect(parsed.m4aUrl).not.toContain("sil-100");
    expect(parsed.mp4Url).not.toMatch(/\.mp3$/);
  });

  test("does not borrow another clip's media when this song has none", () => {
    const html = page(OTHER).replaceAll(OTHER, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const parsed = parseSunoPage(html, UUID);
    expect(parsed.m4aUrl).toBeNull();
    expect(parsed.mp4Url).toBeNull();
    expect(parsed.durationSec).toBeNull();
  });
});

describe("chooseSunoStream", () => {
  const parsed: SunoPage = parseSunoPage(page(), UUID);

  test("uses the cloudfront m4a when it is a plain container", async () => {
    const stream = await chooseSunoStream(parsed, async (url) => url.endsWith(".m4a"));
    expect(stream).toBe(parsed.m4aUrl);
  });

  test("falls back to the song mp4 when the m4a is not directly playable", async () => {
    const probed: string[] = [];
    const stream = await chooseSunoStream(parsed, async (url) => {
      probed.push(url);
      return url.endsWith(".mp4");
    });
    expect(probed).toEqual([parsed.m4aUrl, parsed.mp4Url]);
    expect(stream).toBe(parsed.mp4Url);
  });

  test("errors when neither candidate is a plain container", async () => {
    await expect(chooseSunoStream(parsed, async () => false)).rejects.toThrow(
      "Couldn't find playable audio for this Suno song.",
    );
  });
});

describe("resolveSunoSong", () => {
  test("follows a short link to the song it redirects to", async () => {
    const song = await resolveSunoSong("https://suno.com/s/Ab12", {
      fetchPage: async (url) => {
        expect(url).toBe("https://suno.com/s/Ab12");
        return {
          ok: true,
          status: 200,
          url: `https://suno.com/song/${UUID}?sh=1`,
          text: async () => page(),
        };
      },
      probe: async (url) => url.endsWith(".mp4"),
    });
    expect(song.url).toBe(`https://suno.com/song/${UUID}`);
    expect(song.title).toBe("Raised on Rewind & Friends");
    expect(song.durationSec).toBe(220.64);
    expect(song.streamUrl).toBe(`https://cdn1.suno.ai/${UUID}.mp4`);
  });

  test("rejects a short link that does not land on a song", async () => {
    await expect(resolveSunoSong("https://suno.com/s/nope", {
      fetchPage: async () => ({ ok: true, status: 200, url: "https://suno.com/", text: async () => "<html></html>" }),
    })).rejects.toThrow("That Suno short link didn't resolve to a song.");
  });

  test("rejects playlist and profile links with a clear error", async () => {
    await expect(resolveSunoSong("https://suno.com/playlist/chill")).rejects.toThrow(
      "Suno playlists aren't supported.",
    );
    await expect(resolveSunoSong("https://suno.com/@necthan")).rejects.toThrow(
      "Suno profiles aren't supported.",
    );
    await expect(resolveSunoSong("https://suno.com/pricing")).rejects.toThrow(
      "That Suno link isn't a song.",
    );
  });
});
