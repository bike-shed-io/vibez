import * as soundcloud from "./soundcloud";
import type { TrackRef } from "./soundcloud";
import { isSunoUrl, resolveSunoStreamUrl, resolveSunoTracks } from "./suno";
import { isYouTubeUrl, resolveYouTubeTracks } from "./youtube";

export type { TrackRef };

/** Which resolver a pasted link should use. Anything that isn't Suno or YouTube stays on SoundCloud. */
export function trackSource(url: string): "suno" | "youtube" | "soundcloud" {
  if (isSunoUrl(url)) return "suno";
  if (isYouTubeUrl(url)) return "youtube";
  return "soundcloud";
}

export async function resolveTracks(url: string): Promise<TrackRef[]> {
  if (isSunoUrl(url)) return resolveSunoTracks(url);
  if (isYouTubeUrl(url)) return resolveYouTubeTracks(url);
  return soundcloud.resolveTracks(url);
}

/** Null for YouTube: listeners play through the embedded player, there is no stream. */
export async function resolveStreamUrl(url: string): Promise<string | null> {
  if (isSunoUrl(url)) return resolveSunoStreamUrl(url);
  if (isYouTubeUrl(url)) return null;
  return soundcloud.resolveStreamUrl(url);
}
