import type { WSContext } from "hono/ws";
import { parseEmailList, type SessionUser } from "./auth";
import { notifications } from "./notifications";
import {
  addMember, addToQueue, canTakeDecks, channelInfo, channels, cleanRoomName, clearPlayback, directory,
  endChannel, memberNames, playbackSnapshot, popQueue, removeFromQueue, removeMember, reorderQueue,
  rolesFor, setTrack, shuffleQueue, startChannel, sweepChannels, takeDecks, trust, untrust,
  type Channel, type EndReason,
} from "./channels";
import { resolveStreamUrl, resolveTracks } from "./soundcloud";

export const PROTOCOL_VERSION = 2;
export const UPDATE_MESSAGE = "Update Vibez: brew upgrade --cask vibez";
const DIRECTORY_THROTTLE_MS = 1_000;
const MAX_SKIP_ATTEMPTS = 5;

type Conn = {
  id: string;
  ws: WSContext;
  user: SessionUser | null;
  name: string;
  greeted: boolean;
  channelId: string | null;
};

const connections = new Map<string, Conn>();

function send(conn: Conn, msg: object) {
  conn.ws.send(JSON.stringify(msg));
}

function sendError(conn: Conn, message: string, code?: string) {
  send(conn, code ? { type: "error", code, message } : { type: "error", message });
}

function emailOf(conn: Conn): string | null {
  return conn.user ? conn.user.email.toLowerCase() : null;
}

function isAdmin(conn: Conn): boolean {
  const email = emailOf(conn);
  return !!email && parseEmailList(process.env.ADMIN_EMAILS).has(email);
}

// Re-checked after an `await` (track/stream resolution) so a slow DJ action can't land once
// the sender has left the channel, or lost the decks, while it was in flight.
function stillMember(conn: Conn, ch: Channel): boolean {
  return channels.has(ch.id) && conn.channelId === ch.id;
}

function stillActiveDj(conn: Conn, ch: Channel): boolean {
  return stillMember(conn, ch) && rolesFor(ch, emailOf(conn)).isActiveDj;
}

function membersOf(ch: Channel): Conn[] {
  const result: Conn[] = [];
  for (const id of ch.members.keys()) {
    const conn = connections.get(id);
    if (conn) result.push(conn);
  }
  return result;
}

function broadcastChannel(ch: Channel, msg: object, excludeId?: string) {
  const data = JSON.stringify(msg);
  for (const conn of membersOf(ch)) {
    if (conn.id !== excludeId) conn.ws.send(data);
  }
}

// --- Directory (everyone sees it; throttled) ---

let directoryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDirectory() {
  if (directoryTimer) return;
  directoryTimer = setTimeout(flushDirectory, DIRECTORY_THROTTLE_MS);
}

export function flushDirectory() {
  if (directoryTimer) {
    clearTimeout(directoryTimer);
    directoryTimer = null;
  }
  const data = JSON.stringify({ type: "channels", channels: directory() });
  for (const conn of connections.values()) {
    if (conn.greeted) conn.ws.send(data);
  }
}

// --- Channel state ---

function sendChannelState(conn: Conn, ch: Channel) {
  send(conn, { type: "channel:state", channel: channelInfo(ch), roles: rolesFor(ch, emailOf(conn)), ...playbackSnapshot(ch) });
}

function sendChannelUpdate(ch: Channel, notice?: string) {
  for (const conn of membersOf(ch)) {
    send(conn, {
      type: "channel:update",
      channel: channelInfo(ch),
      roles: rolesFor(ch, emailOf(conn)),
      ...(notice ? { notice } : {}),
    });
  }
  scheduleDirectory();
}

function signedInPeople(ch: Channel) {
  const people = new Map<string, { name: string; email: string; trusted: boolean }>();
  for (const member of ch.members.values()) {
    if (member.email && member.email !== ch.ownerEmail && !people.has(member.email)) {
      people.set(member.email, { name: member.name, email: member.email, trusted: ch.trustedEmails.has(member.email) });
    }
  }
  return [...people.values()];
}

function sendListeners(ch: Channel) {
  const names = memberNames(ch);
  for (const conn of membersOf(ch)) {
    const msg: Record<string, unknown> = { type: "listeners", count: names.length, names };
    if (rolesFor(ch, emailOf(conn)).isOwner) msg.people = signedInPeople(ch);
    send(conn, msg);
  }
  scheduleDirectory();
}

function broadcastQueue(ch: Channel) {
  broadcastChannel(ch, { type: "queue", items: ch.queue });
}

function joinChannel(conn: Conn, ch: Channel) {
  leaveChannel(conn);
  conn.channelId = ch.id;
  const djChanged = addMember(ch, conn.id, { name: conn.name, email: emailOf(conn), connectedAt: Date.now() });
  sendChannelState(conn, ch);
  if (djChanged) sendChannelUpdate(ch);
  sendListeners(ch);
}

function leaveChannel(conn: Conn, now = Date.now()) {
  const ch = conn.channelId ? channels.get(conn.channelId) : undefined;
  conn.channelId = null;
  if (!ch) return;
  if (removeMember(ch, conn.id, now)) sendChannelUpdate(ch);
  sendListeners(ch);
}

function finishChannel(ch: Channel, reason: EndReason) {
  endChannel(ch.id);
  for (const conn of membersOf(ch)) {
    conn.channelId = null;
    send(conn, { type: "channel:ended", channelId: ch.id, reason });
  }
  ch.members.clear();
  scheduleDirectory();
}

export function runSweep(now = Date.now()) {
  for (const { channel, reason } of sweepChannels(now)) finishChannel(channel, reason);
}

// --- Playback ---

function startTrack(ch: Channel, url: string, title: string | null, artwork: string | null, streamUrl: string | null) {
  setTrack(ch, url, title, artwork, streamUrl);
  broadcastChannel(ch, { type: "track", url, title, artwork, streamUrl });
  broadcastChannel(ch, { type: "play", position: 0, timestamp: ch.positionTimestamp });
  scheduleDirectory();
}

function stopPlayback(ch: Channel) {
  clearPlayback(ch);
  broadcastChannel(ch, { type: "track", url: null, title: null, artwork: null, streamUrl: null });
  broadcastChannel(ch, { type: "pause", position: 0 });
  broadcastQueue(ch);
  scheduleDirectory();
}

// Guards against two concurrent advances (duplicate track:ended from two clients, a double
// queue:skip) both popping a queue item for what is really a single advance.
const advancing = new WeakSet<Channel>();

async function advanceQueue(ch: Channel): Promise<void> {
  if (advancing.has(ch)) return;
  advancing.add(ch);
  try {
    await playNextFromQueue(ch);
  } finally {
    advancing.delete(ch);
  }
}

async function playNextFromQueue(ch: Channel, depth = 0): Promise<void> {
  if (depth >= MAX_SKIP_ATTEMPTS) {
    console.warn("[queue] Gave up after skipping", depth, "unplayable tracks");
    return stopPlayback(ch);
  }
  const next = popQueue(ch);
  if (!next) return stopPlayback(ch);

  let streamUrl: string | null = null;
  try {
    streamUrl = await resolveStreamUrl(next.url);
  } catch (err) {
    console.error(`[queue] Skipping "${next.title}" (${next.url}):`, err);
    broadcastQueue(ch);
    return playNextFromQueue(ch, depth + 1);
  }
  if (!channels.has(ch.id)) return;
  startTrack(ch, next.url, next.title, next.artwork, streamUrl);
  broadcastQueue(ch);
}

async function resolveOrReport(conn: Conn, url: string) {
  try {
    return await resolveTracks(url);
  } catch (err: any) {
    sendError(conn, err?.message ?? "Failed to resolve URL");
    return null;
  }
}

// --- Connections ---

export function handleOpen(ws: WSContext, id: string, user: SessionUser | null = null) {
  connections.set(id, { id, ws, user, name: user?.givenName ?? "Anonymous", greeted: false, channelId: null });
}

export function handleClose(id: string) {
  const conn = connections.get(id);
  if (!conn) return;
  leaveChannel(conn);
  connections.delete(id);
}

export async function handleMessage(id: string, raw: string | ArrayBuffer | Uint8Array) {
  const conn = connections.get(id);
  if (!conn) return;

  let msg: any;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    sendError(conn, "Invalid JSON");
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(conn, "Invalid JSON");
    return;
  }

  if (!conn.greeted) {
    if (msg.type !== "hello" || Number(msg.protocol) !== PROTOCOL_VERSION) {
      sendError(conn, UPDATE_MESSAGE, "protocol");
      conn.ws.close(4000, "Unsupported protocol");
      return;
    }
    conn.greeted = true;
    conn.name = String(msg.name ?? "").trim().slice(0, 30) || conn.name;
    const user = conn.user;
    send(conn, {
      type: "welcome",
      user: user ? { email: user.email, name: user.name, givenName: user.givenName, picture: user.picture } : null,
      isAdmin: isAdmin(conn),
    });
    send(conn, { type: "channels", channels: directory() });
    return;
  }

  // Messages that work from the lobby
  switch (msg.type) {
    case "hello":
      return;

    case "channel:join": {
      const target = channels.get(String(msg.channelId ?? ""));
      if (!target) return sendError(conn, "That channel ended", "channel-not-found");
      if (target.id === conn.channelId) return sendChannelState(conn, target);
      return joinChannel(conn, target);
    }

    case "channel:leave":
      return leaveChannel(conn);

    case "live:start": {
      if (!conn.user) return sendError(conn, "Sign in to DJ");
      const { channel, created } = startChannel(
        { email: conn.user.email, name: conn.name, picture: conn.user.picture },
        { djName: msg.djName, roomName: msg.roomName, trustedEmails: msg.trustedEmails },
        Date.now(),
      );
      conn.name = channel.ownerName;
      if (conn.channelId === channel.id) {
        const member = channel.members.get(conn.id);
        if (member) member.name = conn.name;
        sendChannelState(conn, channel);
      } else {
        joinChannel(conn, channel);
      }
      sendChannelUpdate(channel);
      sendListeners(channel);
      if (created) {
        void notifications.notifyWentLive({
          ownerEmail: channel.ownerEmail,
          ownerName: channel.ownerName,
          roomName: channel.roomName,
          channelId: channel.id,
        });
      }
      return;
    }

    case "admin:end": {
      if (!isAdmin(conn)) return sendError(conn, "Admins only");
      const target = channels.get(String(msg.channelId ?? ""));
      if (target) finishChannel(target, "admin");
      return;
    }
  }

  const ch = conn.channelId ? channels.get(conn.channelId) : undefined;
  if (!ch) return sendError(conn, "Join a channel first");
  const email = emailOf(conn);
  const roles = rolesFor(ch, email);

  // Messages for any member, or the owner
  switch (msg.type) {
    case "live:end":
      if (!roles.isOwner) return sendError(conn, "Only the owner can do that");
      return finishChannel(ch, "ended");

    case "live:rename":
      if (!roles.isOwner) return sendError(conn, "Only the owner can do that");
      ch.roomName = cleanRoomName(msg.roomName);
      return sendChannelUpdate(ch);

    case "live:trust":
      if (!roles.isOwner) return sendError(conn, "Only the owner can do that");
      if (trust(ch, String(msg.email ?? ""))) sendChannelUpdate(ch);
      return sendListeners(ch);

    case "live:untrust": {
      if (!roles.isOwner) return sendError(conn, "Only the owner can do that");
      const tookBack = untrust(ch, String(msg.email ?? ""));
      sendChannelUpdate(ch, tookBack ? `${ch.ownerName} took the decks back` : undefined);
      return sendListeners(ch);
    }

    case "dj:take":
      if (!canTakeDecks(ch, email)) return sendError(conn, "Not trusted in this channel");
      if (roles.isActiveDj) return;
      takeDecks(ch, email!, conn.name);
      return sendChannelUpdate(ch, `${ch.activeDjName} took the decks`);

    case "vibez:boost": {
      const boost = Math.max(-1, Math.min(1, Number(msg.boost ?? 0)));
      ch.vibezBoost = boost;
      return broadcastChannel(ch, { type: "vibez", boost });
    }

    case "stream:refresh": {
      if (!ch.trackUrl) return sendError(conn, "No track is loaded");
      const url = ch.trackUrl;
      try {
        const fresh = await resolveStreamUrl(url);
        // The track (or the sender's membership) may have changed while this was in flight —
        // don't clobber a newer track's stream URL with a stale resolution.
        if (!stillMember(conn, ch) || ch.trackUrl !== url) return;
        ch.streamUrl = fresh;
        send(conn, { type: "stream:refreshed", streamUrl: fresh });
      } catch (err) {
        console.error("[ws] stream:refresh failed:", err);
        sendError(conn, "Failed to refresh stream URL");
      }
      return;
    }

    case "queue:add": {
      if (!conn.user) return sendError(conn, "Sign in to DJ");
      const url = String(msg.url || "").trim();
      if (!url) return sendError(conn, "URL is required");
      const tracks = await resolveOrReport(conn, url);
      if (!tracks || !stillMember(conn, ch)) return;
      for (const t of tracks) {
        addToQueue(ch, { id: crypto.randomUUID(), url: t.url, title: t.title, artwork: t.artwork, addedBy: conn.name });
      }
      return broadcastQueue(ch);
    }
  }

  // Everything below is for the active DJ only
  if (!roles.isActiveDj) {
    if (msg.type !== "track:ended" && msg.type !== "dj:position") sendError(conn, "Only the DJ can do that");
    return;
  }

  switch (msg.type) {
    case "dj:play": {
      const url = String(msg.url || "").trim();
      if (!url) return;
      const tracks = await resolveOrReport(conn, url);
      if (!tracks || !stillActiveDj(conn, ch)) return;
      const [first, ...rest] = tracks;
      let streamUrl: string | null = null;
      try {
        streamUrl = await resolveStreamUrl(first.url);
      } catch (err) {
        console.error("[ws] resolveStreamUrl failed:", err);
      }
      if (!stillActiveDj(conn, ch)) return;
      startTrack(ch, first.url, first.title, first.artwork, streamUrl);
      for (const t of rest) {
        addToQueue(ch, { id: crypto.randomUUID(), url: t.url, title: t.title, artwork: t.artwork, addedBy: conn.name });
      }
      if (rest.length > 0) broadcastQueue(ch);
      return;
    }

    case "dj:pause":
      ch.isPlaying = false;
      ch.position = Number(msg.position ?? ch.position);
      broadcastChannel(ch, { type: "pause", position: ch.position }, conn.id);
      return scheduleDirectory();

    case "dj:resume":
      ch.isPlaying = true;
      ch.position = Number(msg.position ?? ch.position);
      ch.positionTimestamp = Date.now();
      ch.lastPlaybackAt = ch.positionTimestamp;
      broadcastChannel(ch, { type: "play", position: ch.position, timestamp: ch.positionTimestamp }, conn.id);
      return scheduleDirectory();

    case "dj:seek":
      ch.position = Number(msg.position ?? 0);
      ch.positionTimestamp = Date.now();
      return broadcastChannel(ch, { type: "seek", position: ch.position, timestamp: ch.positionTimestamp }, conn.id);

    case "dj:position":
      // Silent update — listeners interpolate
      ch.position = Number(msg.position ?? ch.position);
      ch.positionTimestamp = Date.now();
      return;

    case "track:ended": {
      const endedUrl = String(msg.trackUrl || "");
      if (endedUrl && endedUrl !== ch.trackUrl) return;
      if (ch.queue.length === 0) {
        ch.isPlaying = false;
        return scheduleDirectory();
      }
      return advanceQueue(ch);
    }

    case "queue:remove":
      if (removeFromQueue(ch, String(msg.itemId || ""))) broadcastQueue(ch);
      return;

    case "queue:reorder":
      if (reorderQueue(ch, String(msg.itemId || ""), Number(msg.toIndex ?? -1))) broadcastQueue(ch);
      return;

    case "queue:shuffle":
      shuffleQueue(ch);
      return broadcastQueue(ch);

    case "queue:clear":
      ch.queue = [];
      return broadcastQueue(ch);

    case "queue:skip":
      return advanceQueue(ch);

    default:
      return sendError(conn, `Unknown message type: ${msg.type}`);
  }
}
