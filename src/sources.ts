import * as soundcloud from "./soundcloud";
import type { TrackRef } from "./soundcloud";
import { isSunoUrl, resolveSunoStreamUrl, resolveSunoTracks } from "./suno";
import { isUploadUrl, resolveUploadStreamUrl, resolveUploadTrack } from "./uploads";

export type { TrackRef };

/** Which resolver a pasted link should use. Uploads and Suno are explicit; everything else stays on SoundCloud. */
export function trackSource(url: string): "upload" | "suno" | "soundcloud" {
  if (isUploadUrl(url)) return "upload";
  return isSunoUrl(url) ? "suno" : "soundcloud";
}

export async function resolveTracks(url: string): Promise<TrackRef[]> {
  if (isUploadUrl(url)) return [resolveUploadTrack(url)];
  if (isSunoUrl(url)) return resolveSunoTracks(url);
  return soundcloud.resolveTracks(url);
}

export async function resolveStreamUrl(url: string): Promise<string> {
  if (isUploadUrl(url)) return resolveUploadStreamUrl(url);
  if (isSunoUrl(url)) return resolveSunoStreamUrl(url);
  return soundcloud.resolveStreamUrl(url);
}
