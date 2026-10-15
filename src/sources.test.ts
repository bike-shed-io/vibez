import { describe, expect, test } from "bun:test";
import { resolveTracks, trackSource } from "./sources";

describe("track source", () => {
  test("routes Suno hosts to Suno and leaves SoundCloud alone", () => {
    expect(trackSource("https://suno.com/song/6d6536c7-4e24-405c-8d6d-0c4e1c4ee981")).toBe("suno");
    expect(trackSource("https://www.suno.com/s/Ab12")).toBe("suno");
    expect(trackSource("https://soundcloud.com/artist/track")).toBe("soundcloud");
    expect(trackSource("https://on.soundcloud.com/abc")).toBe("soundcloud");
    expect(trackSource("not a url")).toBe("soundcloud");
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
