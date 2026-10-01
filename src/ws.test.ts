import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { channels, DJ_GONE_MS, IDLE_MS } from "./channels";
import { notifications } from "./notifications";
import { flushDirectory, handleClose, handleMessage, handleOpen, runSweep, UPDATE_MESSAGE } from "./ws";

type Fake = { id: string; sent: any[]; closed: boolean };
const open: string[] = [];
const originalNotifyWentLive = notifications.notifyWentLive;
let wentLive: string[] = [];

function user(email: string, givenName: string) {
  return { typ: "session" as const, email, name: `${givenName} Example`, givenName, picture: null, exp: Date.now() + 60_000 };
}

async function connect(id: string, name: string, account: ReturnType<typeof user> | null = null): Promise<Fake> {
  const fake: Fake = { id, sent: [], closed: false };
  handleOpen(
    {
      send(data: string) {
        fake.sent.push(JSON.parse(data));
      },
      close() {
        fake.closed = true;
      },
      readyState: 1,
      raw: undefined,
    } as any,
    id,
    account,
  );
  open.push(id);
  await handleMessage(id, JSON.stringify({ type: "hello", protocol: 2, name }));
  return fake;
}

function last(fake: Fake, type: string) {
  return [...fake.sent].reverse().find((msg) => msg.type === type);
}

async function send(fake: Fake, msg: object) {
  fake.sent.length = 0;
  await handleMessage(fake.id, JSON.stringify(msg));
}

async function goLive(fake: Fake, options: object = {}) {
  await send(fake, { type: "live:start", djName: "DJ Pat", roomName: "fridays", trustedEmails: [], ...options });
  return last(fake, "channel:state").channel.id as string;
}

beforeEach(() => {
  channels.clear();
  wentLive = [];
  notifications.notifyWentLive = async ({ ownerName }) => {
    wentLive.push(ownerName);
  };
});

afterEach(() => {
  for (const id of open.splice(0)) handleClose(id);
  flushDirectory();
  channels.clear();
  notifications.notifyWentLive = originalNotifyWentLive;
  delete process.env.ADMIN_EMAILS;
});

describe("malformed frames", () => {
  test("null, number, and array frames are rejected without throwing, before and after hello", async () => {
    const fake: Fake = { id: "malformed", sent: [], closed: false };
    handleOpen({ send: (d: string) => fake.sent.push(JSON.parse(d)), close: () => (fake.closed = true) } as any, "malformed");
    open.push("malformed");

    for (const frame of ["null", "42", "[]"]) {
      fake.sent.length = 0;
      await handleMessage("malformed", frame);
      expect(fake.sent).toEqual([{ type: "error", message: "Invalid JSON" }]);
    }

    await handleMessage("malformed", JSON.stringify({ type: "hello", protocol: 2, name: "Mal" }));

    for (const frame of ["null", "42", "[]"]) {
      fake.sent.length = 0;
      await handleMessage("malformed", frame);
      expect(fake.sent).toEqual([{ type: "error", message: "Invalid JSON" }]);
    }
  });
});

describe("hello", () => {
  test("old clients are told to update and disconnected", async () => {
    const fake: Fake = { id: "old", sent: [], closed: false };
    handleOpen({ send: (d: string) => fake.sent.push(JSON.parse(d)), close: () => (fake.closed = true) } as any, "old");
    open.push("old");
    await handleMessage("old", JSON.stringify({ type: "join", name: "Old Mac" }));
    expect(fake.sent).toEqual([{ type: "error", code: "protocol", message: UPDATE_MESSAGE }]);
    expect(fake.closed).toBe(true);
  });

  test("greeting returns who you are and the directory", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    expect(pat.sent[0]).toEqual({
      type: "welcome",
      user: { email: "pat@example.com", name: "Pat Example", givenName: "Pat", picture: null },
      isAdmin: false,
    });
    expect(pat.sent[1]).toEqual({ type: "channels", channels: [] });
  });
});

describe("going live", () => {
  test("anonymous listeners cannot go live", async () => {
    const anon = await connect("anon", "Anon");
    await send(anon, { type: "live:start" });
    expect(anon.sent).toEqual([{ type: "error", message: "Sign in to DJ" }]);
    expect(channels.size).toBe(0);
  });

  test("going live creates a channel, joins it, and notifies Slack once", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);

    const state = last(pat, "channel:state");
    expect(state.channel).toEqual({ id, ownerName: "DJ Pat", ownerPicture: null, roomName: "fridays", activeDjName: "DJ Pat", djAway: false });
    expect(state.roles).toEqual({ isOwner: true, isTrusted: false, isActiveDj: true, trustedEmails: [] });
    expect(state.listeners).toEqual(["DJ Pat"]);

    await goLive(pat, { roomName: "renamed" });
    expect(channels.size).toBe(1);
    expect(wentLive).toEqual(["DJ Pat"]);
  });

  test("lobby connections get directory updates", async () => {
    const lobby = await connect("lobby", "Max");
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    await goLive(pat);
    lobby.sent.length = 0;

    flushDirectory();

    expect(last(lobby, "channels").channels.map((c: any) => c.ownerName)).toEqual(["DJ Pat"]);
  });
});

describe("listening", () => {
  test("listeners join, get state, and broadcasts stay inside the channel", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    const outsider = await connect("max", "Max");

    await send(anna, { type: "channel:join", channelId: id });
    expect(last(anna, "channel:state").roles.isActiveDj).toBe(false);
    expect(last(pat, "listeners").names).toEqual(["DJ Pat", "Anna"]);
    expect(last(pat, "listeners").people).toEqual([{ name: "Anna", email: "anna@example.com", trusted: false }]);
    expect(last(anna, "listeners").people).toBeUndefined();

    outsider.sent.length = 0;
    await send(anna, { type: "vibez:boost", boost: 0.5 });
    expect(last(pat, "vibez")).toEqual({ type: "vibez", boost: 0.5 });
    expect(last(outsider, "vibez")).toBeUndefined();
  });

  test("joining an ended channel says so", async () => {
    const anon = await connect("anon", "Anon");
    await send(anon, { type: "channel:join", channelId: "nope" });
    expect(anon.sent).toEqual([{ type: "error", code: "channel-not-found", message: "That channel ended" }]);
  });

  test("messages outside a channel are refused", async () => {
    const anon = await connect("anon", "Anon");
    await send(anon, { type: "vibez:boost", boost: 1 });
    expect(anon.sent).toEqual([{ type: "error", message: "Join a channel first" }]);
  });
});

describe("permissions", () => {
  test("only the active DJ controls playback; track:ended from listeners is ignored", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });

    await send(anna, { type: "dj:pause", position: 1000 });
    expect(anna.sent).toEqual([{ type: "error", message: "Only the DJ can do that" }]);

    await send(anna, { type: "track:ended", trackUrl: "x" });
    expect(anna.sent).toEqual([]);

    await send(pat, { type: "dj:seek", position: 5000 });
    expect(last(anna, "seek").position).toBe(5000);
  });

  test("anonymous members cannot queue", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anon = await connect("anon", "Anon");
    await send(anon, { type: "channel:join", channelId: id });
    await send(anon, { type: "queue:add", url: "https://soundcloud.com/a/b" });
    expect(anon.sent).toEqual([{ type: "error", message: "Sign in to DJ" }]);
  });
});

describe("trusted DJs", () => {
  test("trusted people take the decks with a notice; untrusted cannot", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat, { trustedEmails: ["anna@example.com"] });
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    const max = await connect("max", "Max", user("max@example.com", "Max"));
    await send(anna, { type: "channel:join", channelId: id });
    await send(max, { type: "channel:join", channelId: id });

    await send(max, { type: "dj:take" });
    expect(max.sent).toEqual([{ type: "error", message: "Not trusted in this channel" }]);

    await send(anna, { type: "dj:take" });
    const update = last(pat, "channel:update");
    expect(update.notice).toBe("Anna took the decks");
    expect(update.channel.activeDjName).toBe("Anna");
    expect(update.roles.isActiveDj).toBe(false);
    expect(last(anna, "channel:update").roles.isActiveDj).toBe(true);
  });

  test("owner trusts from the listener list and untrusting takes the decks back", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });

    await send(pat, { type: "live:trust", email: "anna@example.com" });
    expect(last(pat, "channel:update").roles.trustedEmails).toEqual(["anna@example.com"]);
    expect(last(pat, "listeners").people).toEqual([{ name: "Anna", email: "anna@example.com", trusted: true }]);

    await send(anna, { type: "dj:take" });
    await send(pat, { type: "live:untrust", email: "anna@example.com" });
    const update = last(anna, "channel:update");
    expect(update.notice).toBe("DJ Pat took the decks back");
    expect(update.roles).toEqual({ isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [] });
  });

  test("non-owners cannot change the trusted list", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna", user("anna@example.com", "Anna"));
    await send(anna, { type: "channel:join", channelId: id });
    await send(anna, { type: "live:trust", email: "anna@example.com" });
    expect(anna.sent).toEqual([{ type: "error", message: "Only the owner can do that" }]);
  });
});

describe("ending channels", () => {
  test("owner ends the channel and members return to the lobby", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna");
    await send(anna, { type: "channel:join", channelId: id });

    await send(pat, { type: "live:end" });

    expect(last(anna, "channel:ended")).toEqual({ type: "channel:ended", channelId: id, reason: "ended" });
    expect(channels.size).toBe(0);
    await send(anna, { type: "vibez:boost", boost: 1 });
    expect(anna.sent).toEqual([{ type: "error", message: "Join a channel first" }]);
  });

  test("channel ends 2 minutes after the DJ disconnects", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const anna = await connect("anna", "Anna");
    await send(anna, { type: "channel:join", channelId: id });

    handleClose("pat");
    expect(last(anna, "channel:update").channel.djAway).toBe(true);

    runSweep(Date.now() + DJ_GONE_MS - 5_000);
    expect(channels.has(id)).toBe(true);
    runSweep(Date.now() + DJ_GONE_MS + 1_000);
    expect(last(anna, "channel:ended").reason).toBe("dj-gone");
  });

  test("silent channels end after 10 minutes", async () => {
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    runSweep(Date.now() + IDLE_MS + 1_000);
    expect(last(pat, "channel:ended")).toEqual({ type: "channel:ended", channelId: id, reason: "idle" });
  });

  test("admins can end any channel; others cannot", async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    const pat = await connect("pat", "Pat", user("pat@example.com", "Pat"));
    const id = await goLive(pat);
    const boss = await connect("boss", "Boss", user("boss@example.com", "Boss"));
    expect(boss.sent[0].isAdmin).toBe(true);

    await send(pat, { type: "admin:end", channelId: id });
    expect(pat.sent).toEqual([{ type: "error", message: "Admins only" }]);

    await send(boss, { type: "admin:end", channelId: id });
    expect(last(pat, "channel:ended").reason).toBe("admin");
  });
});
