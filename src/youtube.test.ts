import { describe, expect, test } from "bun:test";
import { isYouTubeUrl, resolveYouTubeTracks, youtubeVideoId } from "./youtube";

const ID = "dQw4w9WgXcQ";

describe("youtube links", () => {
  test("extracts the video id from every link shape", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&list=PL123&index=2&t=42s`,
      `https://m.youtube.com/watch?feature=share&v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ]) {
      expect(youtubeVideoId(url)).toBe(ID);
      expect(isYouTubeUrl(url)).toBe(true);
    }
  });

  test("rejects non-video YouTube pages and other hosts", () => {
    expect(youtubeVideoId("https://www.youtube.com/playlist?list=PL123")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@RickAstleyYT")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeVideoId("https://soundcloud.com/a/b")).toBeNull();
    expect(youtubeVideoId("not a url")).toBeNull();
    expect(isYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toBe(true);
    expect(isYouTubeUrl("https://soundcloud.com/a/b")).toBe(false);
  });
});

describe("resolveYouTubeTracks", () => {
  const oembed = (status: number, body?: object) => async (url: string) => {
    expect(url).toBe(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}&format=json`);
    return new Response(body ? JSON.stringify(body) : null, { status });
  };

  test("returns one track with the canonical url, title and thumbnail", async () => {
    const tracks = await resolveYouTubeTracks(`https://youtu.be/${ID}?si=x`, {
      fetch: oembed(200, { title: "Never Gonna Give You Up", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }),
    });
    expect(tracks).toEqual([
      { url: `https://www.youtube.com/watch?v=${ID}`, title: "Never Gonna Give You Up", artwork: "https://i.ytimg.com/vi/x/hqdefault.jpg" },
    ]);
  });

  test("explains playlists, missing videos and embedding bans", async () => {
    await expect(resolveYouTubeTracks("https://www.youtube.com/playlist?list=PL1")).rejects.toThrow(
      "YouTube playlists aren't supported. Paste a single video link.",
    );
    await expect(resolveYouTubeTracks(`https://youtu.be/${ID}`, { fetch: oembed(404) })).rejects.toThrow("Video not found");
    await expect(resolveYouTubeTracks(`https://youtu.be/${ID}`, { fetch: oembed(401) })).rejects.toThrow(
      "This video can't be played outside YouTube",
    );
    await expect(resolveYouTubeTracks(`https://youtu.be/${ID}`, { fetch: oembed(500) })).rejects.toThrow(
      "Couldn't load this YouTube video",
    );
  });
});
