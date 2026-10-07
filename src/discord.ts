import type { DirectoryEntry } from "./channels";
import { listenUrls } from "./notifications";

// Mirrors the live-room directory into one Discord channel: a message per room, edited as the
// track changes and marked ended when the room goes away. No bot — a webhook can edit its own posts.

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type DiscordFeedOptions = {
  webhookUrl?: string;
  radioUrl?: string;
  fetchFn?: Fetch;
  logger?: Pick<Console, "warn">;
};

const LIVE_COLOR = 0xff8c1a;
const ENDED_COLOR = 0x808080;

function roomName(room: DirectoryEntry): string {
  return room.roomName ?? `${room.ownerName}'s vibes`;
}

// Track titles are user content; `[` / `]` would break the link markdown.
function linkText(text: string): string {
  return text.replace(/[[\]]/g, "\\$&");
}

function liveMessage(room: DirectoryEntry, radioUrl: string) {
  const title = room.trackTitle;
  const track = title && room.trackUrl ? `[${linkText(title)}](${room.trackUrl})` : title;
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `🎧 ${room.activeDjName} is live: ${roomName(room)}`,
      url: listenUrls(radioUrl, room.id).web,
      description: track ? `Now playing: ${track}` : "Warming up…",
      thumbnail: room.trackArtwork ? { url: room.trackArtwork } : undefined,
      color: LIVE_COLOR,
    }],
  };
}

function endedMessage(room: DirectoryEntry) {
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `⏹ ${roomName(room)} has ended`, color: ENDED_COLOR }],
  };
}

export function createDiscordFeed(options: DiscordFeedOptions = {}) {
  const webhookUrl = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "";
  const radioUrl = options.radioUrl ?? process.env.RADIO_URL ?? "http://localhost:3000";
  const fetchFn = options.fetchFn ?? fetch;
  const logger = options.logger ?? console;

  // roomId -> what the message currently shows, and the message id once the post (and every edit
  // before this one) has finished. Chaining keeps edits in order and after their post.
  const rooms = new Map<string, { room: DirectoryEntry; body: string; messageId: Promise<string | null> }>();

  async function request(method: "POST" | "PATCH", url: string, body: string): Promise<string | null> {
    try {
      const response = await fetchFn(url, { method, headers: { "content-type": "application/json" }, body });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return method === "POST" ? ((await response.json()) as { id: string }).id : null;
    } catch (err) {
      logger.warn(`[discord] ${method} failed`, err);
      return null;
    }
  }

  function show(room: DirectoryEntry, body: string) {
    const previous = rooms.get(room.id);
    const messageId = previous
      ? previous.messageId.then(async (id) => {
          if (id) await request("PATCH", `${webhookUrl}/messages/${id}`, body);
          return id;
        })
      : request("POST", `${webhookUrl}?wait=true`, body);
    rooms.set(room.id, { room, body, messageId });
    return messageId;
  }

  return {
    // Resolves once Discord shows `live`; sync([]) ends every room (used on shutdown).
    async sync(live: DirectoryEntry[]): Promise<void> {
      if (!webhookUrl) return;
      const pending: Promise<unknown>[] = [];
      const liveIds = new Set(live.map((room) => room.id));
      for (const room of live) {
        const body = JSON.stringify(liveMessage(room, radioUrl));
        if (rooms.get(room.id)?.body !== body) pending.push(show(room, body));
      }
      for (const [id, shown] of rooms) {
        if (liveIds.has(id)) continue;
        pending.push(show(shown.room, JSON.stringify(endedMessage(shown.room))));
        rooms.delete(id);
      }
      await Promise.all(pending);
    },
  };
}

export const discord = createDiscordFeed();
