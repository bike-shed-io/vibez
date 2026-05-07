export type Listener = {
  name: string;
  connectedAt: number;
};

export type QueueItem = {
  id: string;
  url: string;
  title: string | null;
  artwork: string | null;
  addedBy: string;
};

export type Station = {
  djId: string | null;
  djName: string | null;
  djHeartbeatAt: number;
  trackUrl: string | null;
  trackTitle: string | null;
  trackArtwork: string | null;
  streamUrl: string | null;
  isPlaying: boolean;
  position: number;
  positionTimestamp: number;
  vibezBoost: number;
  listeners: Map<string, Listener>;
  queue: QueueItem[];
};

export const station: Station = {
  djId: null,
  djName: null,
  djHeartbeatAt: 0,
  trackUrl: null,
  trackTitle: null,
  trackArtwork: null,
  streamUrl: null,
  isPlaying: false,
  position: 0,
  positionTimestamp: Date.now(),
  vibezBoost: 0,
  listeners: new Map(),
  queue: [],
};

export function getSnapshot() {
  return {
    djName: station.djName,
    trackUrl: station.trackUrl,
    trackTitle: station.trackTitle,
    trackArtwork: station.trackArtwork,
    streamUrl: station.streamUrl,
    isPlaying: station.isPlaying,
    position: station.position,
    positionTimestamp: station.positionTimestamp,
    vibezBoost: station.vibezBoost,
    listeners: listenerNames(),
    queue: station.queue,
  };
}

export function listenerNames(): string[] {
  return Array.from(station.listeners.values()).map((l) => l.name);
}

export function listenerCount(): number {
  return station.listeners.size;
}

export function setTrack(url: string, title: string | null, artwork: string | null, streamUrl: string | null) {
  station.trackUrl = url;
  station.trackTitle = title;
  station.trackArtwork = artwork;
  station.streamUrl = streamUrl;
  station.isPlaying = true;
  station.position = 0;
  station.positionTimestamp = Date.now();
}

export function claimDj(id: string, name: string) {
  station.djId = id;
  station.djName = name;
  station.djHeartbeatAt = Date.now();
}

export function releaseDj() {
  station.djId = null;
  station.djName = null;
  // Don't clear track/streamUrl so listeners can keep hearing the last track
}

export function touchDjHeartbeat() {
  station.djHeartbeatAt = Date.now();
}

export function isDj(id: string): boolean {
  return station.djId === id;
}

export function addToQueue(item: QueueItem) {
  station.queue.push(item);
}

export function removeFromQueue(itemId: string): boolean {
  const idx = station.queue.findIndex((q) => q.id === itemId);
  if (idx === -1) return false;
  station.queue.splice(idx, 1);
  return true;
}

export function reorderQueue(itemId: string, toIndex: number): boolean {
  const fromIdx = station.queue.findIndex((q) => q.id === itemId);
  if (fromIdx === -1) return false;
  const clamped = Math.max(0, Math.min(station.queue.length - 1, toIndex));
  const [item] = station.queue.splice(fromIdx, 1);
  station.queue.splice(clamped, 0, item);
  return true;
}

export function shuffleQueue() {
  for (let i = station.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [station.queue[i], station.queue[j]] = [station.queue[j], station.queue[i]];
  }
}

export function popQueue(): QueueItem | undefined {
  return station.queue.shift();
}

export function getQueueSnapshot(): QueueItem[] {
  return station.queue;
}

export function clearPlayback() {
  station.trackUrl = null;
  station.trackTitle = null;
  station.trackArtwork = null;
  station.streamUrl = null;
  station.isPlaying = false;
  station.position = 0;
  station.positionTimestamp = Date.now();
}
