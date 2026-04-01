export type Listener = {
  name: string;
  connectedAt: number;
};

export type Station = {
  djId: string | null;
  djName: string | null;
  trackUrl: string | null;
  trackTitle: string | null;
  trackArtwork: string | null;
  isPlaying: boolean;
  position: number;
  positionTimestamp: number;
  listeners: Map<string, Listener>;
};

export const station: Station = {
  djId: null,
  djName: null,
  trackUrl: null,
  trackTitle: null,
  trackArtwork: null,
  isPlaying: false,
  position: 0,
  positionTimestamp: Date.now(),
  listeners: new Map(),
};

export function getSnapshot() {
  return {
    djName: station.djName,
    trackUrl: station.trackUrl,
    trackTitle: station.trackTitle,
    trackArtwork: station.trackArtwork,
    isPlaying: station.isPlaying,
    position: station.position,
    positionTimestamp: station.positionTimestamp,
    listeners: listenerNames(),
  };
}

export function listenerNames(): string[] {
  return Array.from(station.listeners.values()).map((l) => l.name);
}

export function listenerCount(): number {
  return station.listeners.size;
}

export function setTrack(url: string, title: string | null, artwork: string | null) {
  station.trackUrl = url;
  station.trackTitle = title;
  station.trackArtwork = artwork;
  station.isPlaying = true;
  station.position = 0;
  station.positionTimestamp = Date.now();
}

export function claimDj(id: string, name: string) {
  station.djId = id;
  station.djName = name;
}

export function releaseDj() {
  station.djId = null;
  station.djName = null;
  station.isPlaying = false;
}

export function isDj(id: string): boolean {
  return station.djId === id;
}
