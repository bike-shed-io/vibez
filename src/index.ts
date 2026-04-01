import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { basicAuth } from "hono/basic-auth";
import { createBunWebSocket } from "hono/bun";
import { handleOpen, handleClose, handleMessage } from "./ws";
import { startSlack } from "./slack";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

// Optional Basic Auth — protects all routes when AUTH_PASSWORD is set
// WebSocket upgrades are excluded (the page itself requires auth to load)
const authPassword = process.env.AUTH_PASSWORD;
if (authPassword) {
  const auth = basicAuth({
    verifyUser: (_username, password) => password === authPassword,
  });
  app.use("*", async (c, next) => {
    if (c.req.header("upgrade") === "websocket") return next();
    return auth(c, next);
  });
}

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
