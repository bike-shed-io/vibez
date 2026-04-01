import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { handleOpen, handleClose, handleMessage } from "./ws";
import { startSlack } from "./slack";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

// WebSocket endpoint
app.get(
  "/ws",
  upgradeWebSocket(() => {
    const id = crypto.randomUUID();
    return {
      onOpen(_evt, ws) {
        handleOpen(ws, id);
      },
      onMessage(evt, _ws) {
        handleMessage(id, evt.data);
      },
      onClose() {
        handleClose(id);
      },
    };
  })
);

// Static files
app.use("/*", serveStatic({ root: "./public" }));

// Start
const port = Number(process.env.PORT) || 3000;

startSlack().catch((err) => {
  console.error("[slack] Failed to start Slack bot:", err.message);
});

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`[vibez] Team Radio running at http://localhost:${port}`);
