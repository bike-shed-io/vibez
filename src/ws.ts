import type { WSContext } from "hono/ws";
import { station, getSnapshot, setTrack, claimDj, releaseDj, isDj, listenerNames, listenerCount } from "./station";
import { fetchTrackMeta, resolveStreamUrl } from "./soundcloud";

type Conn = {
  id: string;
  name: string;
  ws: WSContext;
};

const connections = new Map<string, Conn>();

function broadcast(msg: object, exclude?: string) {
  const data = JSON.stringify(msg);
  for (const [id, conn] of connections) {
    if (id !== exclude) {
      conn.ws.send(data);
    }
  }
}

function broadcastListeners() {
  broadcast({ type: "listeners", count: listenerCount(), names: listenerNames() });
}

export function handleOpen(ws: WSContext, id: string) {
  // Connection is registered but not yet named — wait for "join" message
  connections.set(id, { id, name: "Anonymous", ws });
}

export function handleClose(id: string) {
  const conn = connections.get(id);
  if (!conn) return;

  station.listeners.delete(id);
  connections.delete(id);

  if (isDj(id)) {
    releaseDj();
    broadcast({ type: "dj:changed", djName: null });
    broadcast({ type: "vibez", boost: 0 });
  }

  broadcastListeners();
}

export async function handleMessage(id: string, raw: string | ArrayBuffer | Uint8Array) {
  const conn = connections.get(id);
  if (!conn) return;

  let msg: any;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    conn.ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    return;
  }

  switch (msg.type) {
    case "join": {
      const name = String(msg.name || "Anonymous").slice(0, 30);
      conn.name = name;
      station.listeners.set(id, { name, connectedAt: Date.now() });
      conn.ws.send(JSON.stringify({ type: "sync", ...getSnapshot() }));
      broadcastListeners();
      break;
    }

    case "dj:claim": {
      if (station.djId && station.djId !== id) {
        conn.ws.send(JSON.stringify({ type: "error", message: `${station.djName} is already DJing` }));
        return;
      }
      const name = conn.name;
      claimDj(id, name);
      broadcast({ type: "dj:changed", djName: name });
      break;
    }

    case "dj:release": {
      if (!isDj(id)) return;
      releaseDj();
      broadcast({ type: "dj:changed", djName: null });
      broadcast({ type: "vibez", boost: 0 });
      break;
    }

    case "vibez:boost": {
      if (!isDj(id)) return;
      const boost = Math.max(-1, Math.min(1, Number(msg.boost ?? 0)));
      station.vibezBoost = boost;
      broadcast({ type: "vibez", boost });
      break;
    }

    case "dj:play": {
      if (!isDj(id)) return;
      const url = String(msg.url || "");
      if (!url) return;

      let title: string | null = null;
      let artwork: string | null = null;
      try {
        const meta = await fetchTrackMeta(url);
        title = meta.title;
        artwork = meta.artwork;
      } catch {
        // Proceed without metadata
      }

      let streamUrl: string | null = null;
      try {
        streamUrl = await resolveStreamUrl(url);
      } catch (err) {
        console.error("[ws] resolveStreamUrl failed:", err);
      }

      setTrack(url, title, artwork, streamUrl);
      broadcast({ type: "track", url: station.trackUrl, title: station.trackTitle, artwork: station.trackArtwork, streamUrl: station.streamUrl });
      broadcast({ type: "play", position: 0, timestamp: station.positionTimestamp });
      break;
    }

    case "dj:pause": {
      if (!isDj(id)) return;
      station.isPlaying = false;
      station.position = Number(msg.position ?? station.position);
      broadcast({ type: "pause", position: station.position }, id);
      break;
    }

    case "dj:resume": {
      if (!isDj(id)) return;
      station.isPlaying = true;
      station.position = Number(msg.position ?? station.position);
      station.positionTimestamp = Date.now();
      broadcast({ type: "play", position: station.position, timestamp: station.positionTimestamp }, id);
      break;
    }

    case "dj:seek": {
      if (!isDj(id)) return;
      station.position = Number(msg.position ?? 0);
      station.positionTimestamp = Date.now();
      broadcast({ type: "seek", position: station.position, timestamp: station.positionTimestamp }, id);
      break;
    }

    case "dj:position": {
      if (!isDj(id)) return;
      station.position = Number(msg.position ?? station.position);
      station.positionTimestamp = Date.now();
      // Silent update — no broadcast needed for heartbeat, listeners interpolate
      break;
    }

    case "stream:refresh": {
      if (!station.trackUrl) {
        conn.ws.send(JSON.stringify({ type: "error", message: "No track is loaded" }));
        break;
      }
      try {
        const freshStreamUrl = await resolveStreamUrl(station.trackUrl);
        station.streamUrl = freshStreamUrl;
        conn.ws.send(JSON.stringify({ type: "stream:refreshed", streamUrl: freshStreamUrl }));
      } catch (err) {
        console.error("[ws] stream:refresh failed:", err);
        conn.ws.send(JSON.stringify({ type: "error", message: "Failed to refresh stream URL" }));
      }
      break;
    }

    default:
      conn.ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
  }
}

// Called by Slack bot to play a track without a WS connection
export async function playFromSlack(url: string): Promise<{ title: string | null; artwork: string | null }> {
  let title: string | null = null;
  let artwork: string | null = null;
  try {
    const meta = await fetchTrackMeta(url);
    title = meta.title;
    artwork = meta.artwork;
  } catch {
    // Proceed without metadata
  }

  let streamUrl: string | null = null;
  try {
    streamUrl = await resolveStreamUrl(url);
  } catch (err) {
    console.error("[ws] resolveStreamUrl failed in playFromSlack:", err);
  }

  setTrack(url, title, artwork, streamUrl);
  broadcast({ type: "track", url: station.trackUrl, title: station.trackTitle, artwork: station.trackArtwork, streamUrl: station.streamUrl });
  broadcast({ type: "play", position: 0, timestamp: station.positionTimestamp });
  return { title, artwork };
}
