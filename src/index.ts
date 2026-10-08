import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { handleOpen, handleClose, handleMessage, runSweep } from "./ws";
import { startSlack } from "./slack";
import { discord } from "./discord";
import { restoreChannels, snapshotChannels } from "./channels";
import { createAuthRoutes, loadAuthConfig, sessionFromHeaders } from "./auth";

const { upgradeWebSocket, websocket } = createBunWebSocket();
const authConfig = loadAuthConfig();

const app = new Hono();

app.route("/auth", createAuthRoutes(authConfig));

// WebSocket endpoint — everyone may listen; the session (cookie or Bearer) only unlocks DJ/queue actions
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const id = crypto.randomUUID();
    const user = sessionFromHeaders(
      { cookie: c.req.header("cookie"), authorization: c.req.header("authorization") },
      authConfig,
      Date.now(),
    );
    return {
      onOpen(_evt, ws) {
        handleOpen(ws, id, user);
      },
      onMessage(evt, _ws) {
        // Bun delivers text frames as strings and binary frames as buffers, never Blobs
        handleMessage(id, evt.data as string | ArrayBuffer).catch((err) =>
          console.error("[ws] handleMessage failed:", err),
        );
      },
      onClose() {
        handleClose(id);
      },
    };
  })
);

// Channel deep links are client-side routes
app.get("/c/*", serveStatic({ path: "./public/index.html" }));

// Static files
app.use("/*", serveStatic({ root: "./public" }));

// Start
const port = Number(process.env.PORT) || 3005;

startSlack().catch((err) => {
  console.error("[slack] Failed to start Slack bot:", err.message);
});

setInterval(() => runSweep(), 15_000);

// Deploys restart the container: rooms (and their Discord cards) are saved on SIGTERM and restored
// on boot. .cache is a host volume (docker-compose.prod.yml), so the file outlives the container.
const ROOMS_FILE = join(import.meta.dir, "..", ".cache", "rooms.json");

if (existsSync(ROOMS_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(ROOMS_FILE, "utf8"));
    restoreChannels(saved.rooms);
    discord.load(saved.discord);
    console.log(`[vibez] Restored ${saved.rooms.channels.length} room(s) from before the restart`);
  } catch (err) {
    console.error("[vibez] Could not restore rooms:", err);
  }
  unlinkSync(ROOMS_FILE); // a bad file must not come back on the next boot
}

process.on("SIGTERM", async () => {
  try {
    mkdirSync(dirname(ROOMS_FILE), { recursive: true });
    const data = JSON.stringify({ rooms: snapshotChannels(Date.now()), discord: await discord.save() });
    writeFileSync(`${ROOMS_FILE}.tmp`, data);
    renameSync(`${ROOMS_FILE}.tmp`, ROOMS_FILE); // a kill mid-write leaves no torn file
  } catch (err) {
    console.error("[vibez] Could not save rooms, ending them:", err);
    await discord.sync([]);
  }
  process.exit(0);
});

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`[vibez] Team Radio running at http://localhost:${port}`);
