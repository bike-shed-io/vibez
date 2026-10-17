import { describe, expect, test } from "bun:test";
import { describeSunoLink, isSunoUrl, songPageUrl, sunoLinkError, sunoSongId } from "./suno";

const UUID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981";

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

  test("names the song id a track URL stands for", () => {
    expect(sunoSongId(`https://www.suno.com/song/${UUID.toUpperCase()}/?si=1`)).toBe(UUID);
    expect(songPageUrl(UUID.toUpperCase())).toBe(`https://suno.com/song/${UUID}`);
    expect(sunoSongId("https://suno.com/s/Ab12")).toBeNull();
    expect(sunoSongId("https://soundcloud.com/artist/track")).toBeNull();
  });

  test("every rejection points at the link shape that works", () => {
    expect(sunoLinkError("playlist")).toContain("Suno playlists aren't supported.");
    expect(sunoLinkError("profile")).toContain("Suno profiles aren't supported.");
    expect(sunoLinkError("short")).toContain("That Suno short link didn't resolve to a song.");
    expect(sunoLinkError("other")).toContain("That Suno link isn't a song.");
    for (const kind of ["playlist", "profile", "short", "other"] as const) {
      expect(sunoLinkError(kind)).toContain("suno.com/song/");
    }
  });
});
