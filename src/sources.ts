import * as soundcloud from "./soundcloud";
import type { TrackRef } from "./soundcloud";
import * as proxy from "./suno-proxy";
import { describeSunoLink, isSunoUrl, sunoLinkError } from "./suno";

export type { TrackRef };

/** A room plays from one source. Switching clears the queue, so links can't mix. */
export type RoomSource = "soundcloud" | "suno";

export const ROOM_SOURCES: RoomSource[] = ["soundcloud", "suno"];

/** What a room needs to resolve a link: its source, and its DJ's Suno token. */
export type SourceContext = {
  source: RoomSource;
  sunoToken: string | null;
};

export function isRoomSource(value: unknown): value is RoomSource {
  return value === "soundcloud" || value === "suno";
}

export function sourceLabel(source: RoomSource): string {
  return source === "suno" ? "Suno" : "SoundCloud";
}

export async function resolveTracks(url: string, ctx: SourceContext): Promise<TrackRef[]> {
  if (ctx.source !== "suno") {
    if (isSunoUrl(url)) throw new Error("This room plays from SoundCloud. Switch the source to Suno first.");
    return soundcloud.resolveTracks(url);
  }

  const token = sunoToken(ctx);
  // The proxy downloads in the background, so adding a song is quick even though
  // playing it later waits for the file.
  const song = await proxy.requestSong(token, sunoSongUrl(url));
  return [{ url: song.pageUrl || url, title: song.title, artwork: song.artwork }];
}

export async function resolveStreamUrl(url: string, ctx: SourceContext): Promise<string> {
  if (ctx.source !== "suno") return soundcloud.resolveStreamUrl(url);
  return proxy.resolveAudioUrl(sunoToken(ctx), sunoSongUrl(url));
}

/** Rejects links this room's source can't play, with the reason the DJ needs. */
function sunoSongUrl(url: string): string {
  const link = describeSunoLink(url);
  if (link.kind === "song" || link.kind === "short") return url;
  if (!isSunoUrl(url)) throw new Error("This room plays from Suno. Paste a suno.com song link.");
  throw new Error(sunoLinkError(link.kind));
}

function sunoToken(ctx: SourceContext): string {
  if (!proxy.isConfigured()) throw new Error("Suno isn't set up on this server.");
  if (!ctx.sunoToken) throw new Error("This room needs a Suno access token. Pick the source again to enter one.");
  return ctx.sunoToken;
}
