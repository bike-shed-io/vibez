import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { handleOpen, handleClose, handleMessage, runSweep } from "./ws";
import { startSlack } from "./slack";
import { discord } from "./discord";
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

// Deploys stop the container: close the Discord posts of the rooms that die with this process.
process.on("SIGTERM", async () => {
  await discord.sync([]);
  process.exit(0);
});

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`[vibez] Team Radio running at http://localhost:${port}`);
