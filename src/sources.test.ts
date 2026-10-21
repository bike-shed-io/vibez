import { describe, expect, test } from "bun:test";
import { resolveStreamUrl, resolveTracks, trackSource } from "./sources";

describe("track source", () => {
  test("routes Suno and YouTube hosts and leaves SoundCloud alone", () => {
    expect(trackSource("https://suno.com/song/6d6536c7-4e24-405c-8d6d-0c4e1c4ee981")).toBe("suno");
    expect(trackSource("https://www.suno.com/s/Ab12")).toBe("suno");
    expect(trackSource("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(trackSource("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(trackSource("https://soundcloud.com/artist/track")).toBe("soundcloud");
    expect(trackSource("https://on.soundcloud.com/abc")).toBe("soundcloud");
    expect(trackSource("not a url")).toBe("soundcloud");
  });

  test("YouTube has no stream url", async () => {
    expect(await resolveStreamUrl("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
  });

  test("playlist and profile links fail in the shared resolver", async () => {
    await expect(resolveTracks("https://suno.com/playlist/chill")).rejects.toThrow(
      "Suno playlists aren't supported.",
    );
    await expect(resolveTracks("https://suno.com/profile/necthan")).rejects.toThrow(
      "Suno profiles aren't supported.",
    );
  });
});
