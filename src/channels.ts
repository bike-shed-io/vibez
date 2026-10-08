export type QueueItem = {
  id: string;
  url: string;
  title: string | null;
  artwork: string | null;
  addedBy: string;
};

export type Member = {
  name: string;
  email: string | null;
  connectedAt: number;
};

export type Owner = {
  email: string;
  name: string;
  picture: string | null;
};

export type Channel = {
  id: string;
  ownerEmail: string;
  ownerName: string;
  ownerPicture: string | null;
  roomName: string | null;
  trustedEmails: Set<string>;
  activeDjEmail: string;
  activeDjName: string;
  startedAt: number;
  lastPlaybackAt: number;
  activeDjGoneSince: number | null;
  members: Map<string, Member>; // connection id → member
  trackUrl: string | null;
  trackTitle: string | null;
  trackArtwork: string | null;
  streamUrl: string | null;
  isPlaying: boolean;
  position: number;
  positionTimestamp: number;
  vibezBoost: number;
  queue: QueueItem[];
};

export type EndReason = "ended" | "dj-gone" | "idle" | "admin";

export type ChannelInfo = {
  id: string;
  ownerName: string;
  ownerPicture: string | null;
  roomName: string | null;
  activeDjName: string;
  djAway: boolean;
};

export type DirectoryEntry = ChannelInfo & {
  trackTitle: string | null;
  trackUrl: string | null;
  trackArtwork: string | null;
  isPlaying: boolean;
  listenerCount: number;
};

export type Roles = {
  isOwner: boolean;
  isTrusted: boolean;
  isActiveDj: boolean;
  trustedEmails: string[];
};

export const DJ_GONE_MS = 2 * 60_000;
export const IDLE_MS = 10 * 60_000;
const MAX_TRUSTED = 50;
const MAX_EMAIL_LEN = 254;

export const channels = new Map<string, Channel>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function cleanRoomName(value: unknown): string | null {
  return cleanText(value, 40) || null;
}

function parseTrusted(value: unknown, ownerEmail: string): Set<string> {
  if (!Array.isArray(value)) return new Set();
  const result = new Set<string>();
  for (const entry of value) {
    if (result.size >= MAX_TRUSTED) break;
    if (typeof entry !== "string" || entry.length > MAX_EMAIL_LEN) continue;
    const email = normalizeEmail(entry);
    if (email.includes("@") && email !== ownerEmail) result.add(email);
  }
  return result;
}

function setActiveDj(ch: Channel, email: string, name: string) {
  ch.activeDjEmail = email;
  ch.activeDjName = name;
  ch.activeDjGoneSince = null;
}

function hasMember(ch: Channel, email: string): boolean {
  for (const member of ch.members.values()) {
    if (member.email === email) return true;
  }
  return false;
}

export function findChannelByOwner(email: string): Channel | undefined {
  const owner = normalizeEmail(email);
  for (const ch of channels.values()) {
    if (ch.ownerEmail === owner) return ch;
  }
  return undefined;
}

export function startChannel(
  owner: Owner,
  options: { djName?: unknown; roomName?: unknown; trustedEmails?: unknown },
  now: number,
): { channel: Channel; created: boolean } {
  const ownerEmail = normalizeEmail(owner.email);
  const ownerName = cleanText(options.djName, 30) || cleanText(owner.name, 30) || "DJ";
  const roomName = cleanRoomName(options.roomName);
  const trustedEmails = parseTrusted(options.trustedEmails, ownerEmail);

  const existing = findChannelByOwner(ownerEmail);
  if (existing) {
    existing.ownerName = ownerName;
    existing.ownerPicture = owner.picture;
    existing.roomName = roomName;
    // Going live again (e.g. from a second device) unions the trusted list rather than
    // replacing it — dropping someone requires an explicit live:untrust.
    for (const email of trustedEmails) {
      if (existing.trustedEmails.size >= MAX_TRUSTED) break;
      existing.trustedEmails.add(email);
    }
    if (existing.activeDjEmail === ownerEmail || !existing.trustedEmails.has(existing.activeDjEmail)) {
      setActiveDj(existing, ownerEmail, ownerName);
    }
    return { channel: existing, created: false };
  }

  const channel: Channel = {
    id: crypto.randomUUID().slice(0, 8),
    ownerEmail,
    ownerName,
    ownerPicture: owner.picture,
    roomName,
    trustedEmails,
    activeDjEmail: ownerEmail,
    activeDjName: ownerName,
    startedAt: now,
    lastPlaybackAt: now,
    activeDjGoneSince: null,
    members: new Map(),
    trackUrl: null,
    trackTitle: null,
    trackArtwork: null,
    streamUrl: null,
    isPlaying: false,
    position: 0,
    positionTimestamp: now,
    vibezBoost: 0,
    queue: [],
  };
  channels.set(channel.id, channel);
  return { channel, created: true };
}

export function endChannel(id: string): Channel | undefined {
  const ch = channels.get(id);
  channels.delete(id);
  return ch;
}

/** Returns true when the DJ state changed (away cleared or decks back to the owner). */
export function addMember(ch: Channel, connId: string, member: Member): boolean {
  const email = member.email ? normalizeEmail(member.email) : null;
  ch.members.set(connId, { ...member, email });
  if (ch.activeDjGoneSince === null || !email) return false;
  if (email === ch.activeDjEmail) {
    ch.activeDjGoneSince = null;
    return true;
  }
  if (email === ch.ownerEmail) {
    setActiveDj(ch, ch.ownerEmail, ch.ownerName);
    return true;
  }
  return false;
}

/** Returns true when the DJ state changed (decks back to the owner, or DJ now away). */
export function removeMember(ch: Channel, connId: string, now: number): boolean {
  const member = ch.members.get(connId);
  ch.members.delete(connId);
  if (!member?.email || member.email !== ch.activeDjEmail || hasMember(ch, ch.activeDjEmail)) return false;
  if (ch.activeDjEmail !== ch.ownerEmail && hasMember(ch, ch.ownerEmail)) {
    setActiveDj(ch, ch.ownerEmail, ch.ownerName);
    return true;
  }
  ch.activeDjGoneSince = now;
  return true;
}

export function isActiveDj(ch: Channel, email: string | null): boolean {
  return !!email && normalizeEmail(email) === ch.activeDjEmail;
}

export function canTakeDecks(ch: Channel, email: string | null): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  return normalized === ch.ownerEmail || ch.trustedEmails.has(normalized);
}

export function takeDecks(ch: Channel, email: string, name: string) {
  const normalized = normalizeEmail(email);
  let djName = cleanText(name, 30);
  if (!djName) {
    djName = normalized.split("@")[0];
  }
  setActiveDj(ch, normalized, normalized === ch.ownerEmail ? ch.ownerName : djName);
}

/** Returns true when the email was newly trusted. */
export function trust(ch: Channel, email: string): boolean {
  if (email.length > MAX_EMAIL_LEN) return false;
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@") || normalized === ch.ownerEmail || ch.trustedEmails.has(normalized)) return false;
  if (ch.trustedEmails.size >= MAX_TRUSTED) return false;
  ch.trustedEmails.add(normalized);
  return true;
}

/** Returns true when the removed person held the decks (they go back to the owner). */
export function untrust(ch: Channel, email: string): boolean {
  const normalized = normalizeEmail(email);
  ch.trustedEmails.delete(normalized);
  if (ch.activeDjEmail !== normalized) return false;
  setActiveDj(ch, ch.ownerEmail, ch.ownerName);
  return true;
}

export function rolesFor(ch: Channel, email: string | null): Roles {
  const normalized = email ? normalizeEmail(email) : null;
  const isOwner = normalized === ch.ownerEmail;
  return {
    isOwner,
    isTrusted: normalized !== null && ch.trustedEmails.has(normalized),
    isActiveDj: normalized === ch.activeDjEmail,
    trustedEmails: isOwner ? [...ch.trustedEmails].sort() : [],
  };
}

export function channelInfo(ch: Channel): ChannelInfo {
  return {
    id: ch.id,
    ownerName: ch.ownerName,
    ownerPicture: ch.ownerPicture,
    roomName: ch.roomName,
    activeDjName: ch.activeDjName,
    djAway: ch.activeDjGoneSince !== null,
  };
}

export function directoryEntry(ch: Channel): DirectoryEntry {
  return {
    ...channelInfo(ch),
    trackTitle: ch.trackTitle,
    trackUrl: ch.trackUrl,
    trackArtwork: ch.trackArtwork,
    isPlaying: ch.isPlaying,
    listenerCount: ch.members.size,
  };
}

export function directory(): DirectoryEntry[] {
  return [...channels.values()]
    .sort((a, b) => b.members.size - a.members.size || a.startedAt - b.startedAt)
    .map(directoryEntry);
}

export function sweepChannels(now: number): Array<{ channel: Channel; reason: EndReason }> {
  const ended: Array<{ channel: Channel; reason: EndReason }> = [];
  for (const ch of channels.values()) {
    if (ch.isPlaying) ch.lastPlaybackAt = now;
    if (ch.activeDjGoneSince !== null && now - ch.activeDjGoneSince >= DJ_GONE_MS) {
      ended.push({ channel: ch, reason: "dj-gone" });
    } else if (!ch.isPlaying && now - ch.lastPlaybackAt >= IDLE_MS) {
      ended.push({ channel: ch, reason: "idle" });
    }
  }
  for (const { channel } of ended) channels.delete(channel.id);
  return ended;
}

// --- Restart ---
// A deploy restarts the server; rooms are written on shutdown and restored on boot. Connections
// are not kept: listeners rejoin by themselves, and the DJ counts as away since the shutdown, so
// the usual DJ_GONE_MS sweep ends a room whose DJ doesn't come back.

type ChannelSnapshot = Omit<Channel, "members" | "trustedEmails"> & { trustedEmails: string[] };

export function snapshotChannels(now: number) {
  const saved: ChannelSnapshot[] = [...channels.values()].map(({ members, trustedEmails, ...ch }) => ({
    ...ch,
    trustedEmails: [...trustedEmails],
  }));
  return { savedAt: now, channels: saved };
}

export function restoreChannels(snapshot: ReturnType<typeof snapshotChannels>) {
  for (const ch of snapshot.channels) {
    channels.set(ch.id, {
      ...ch,
      trustedEmails: new Set(ch.trustedEmails),
      members: new Map(),
      activeDjGoneSince: ch.activeDjGoneSince ?? snapshot.savedAt,
    });
  }
}

export function memberNames(ch: Channel): string[] {
  return [...ch.members.values()].map((member) => member.name);
}

export function playbackSnapshot(ch: Channel) {
  return {
    trackUrl: ch.trackUrl,
    trackTitle: ch.trackTitle,
    trackArtwork: ch.trackArtwork,
    streamUrl: ch.streamUrl,
    isPlaying: ch.isPlaying,
    position: ch.position,
    positionTimestamp: ch.positionTimestamp,
    vibezBoost: ch.vibezBoost,
    listeners: memberNames(ch),
    queue: ch.queue,
  };
}

export function setTrack(
  ch: Channel,
  url: string,
  title: string | null,
  artwork: string | null,
  streamUrl: string | null,
  now = Date.now(),
) {
  ch.trackUrl = url;
  ch.trackTitle = title;
  ch.trackArtwork = artwork;
  ch.streamUrl = streamUrl;
  ch.isPlaying = true;
  ch.position = 0;
  ch.positionTimestamp = now;
  ch.lastPlaybackAt = now;
}

export function clearPlayback(ch: Channel, now = Date.now()) {
  ch.trackUrl = null;
  ch.trackTitle = null;
  ch.trackArtwork = null;
  ch.streamUrl = null;
  ch.isPlaying = false;
  ch.position = 0;
  ch.positionTimestamp = now;
}

export function addToQueue(ch: Channel, item: QueueItem) {
  ch.queue.push(item);
}

export function removeFromQueue(ch: Channel, itemId: string): boolean {
  const index = ch.queue.findIndex((item) => item.id === itemId);
  if (index === -1) return false;
  ch.queue.splice(index, 1);
  return true;
}

export function reorderQueue(ch: Channel, itemId: string, toIndex: number): boolean {
  const fromIndex = ch.queue.findIndex((item) => item.id === itemId);
  if (fromIndex === -1) return false;
  const clamped = Math.max(0, Math.min(ch.queue.length - 1, toIndex));
  const [item] = ch.queue.splice(fromIndex, 1);
  ch.queue.splice(clamped, 0, item);
  return true;
}

export function shuffleQueue(ch: Channel) {
  for (let i = ch.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ch.queue[i], ch.queue[j]] = [ch.queue[j], ch.queue[i]];
  }
}

export function popQueue(ch: Channel): QueueItem | undefined {
  return ch.queue.shift();
}
