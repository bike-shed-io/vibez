import * as soundcloud from "./soundcloud";
import type { TrackRef } from "./soundcloud";
import { isSunoUrl, resolveSunoStreamUrl, resolveSunoTracks } from "./suno";

export type { TrackRef };

/** Which resolver a pasted link should use. Anything that isn't Suno stays on SoundCloud. */
export function trackSource(url: string): "suno" | "soundcloud" {
  return isSunoUrl(url) ? "suno" : "soundcloud";
}

export async function resolveTracks(url: string): Promise<TrackRef[]> {
  if (isSunoUrl(url)) return resolveSunoTracks(url);
  return soundcloud.resolveTracks(url);
}

export async function resolveStreamUrl(url: string): Promise<string> {
  if (isSunoUrl(url)) return resolveSunoStreamUrl(url);
  return soundcloud.resolveStreamUrl(url);
}
