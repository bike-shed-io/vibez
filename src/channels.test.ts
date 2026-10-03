import { beforeEach, describe, expect, test } from "bun:test";
import {
  addMember, canTakeDecks, channels, directory, DJ_GONE_MS, IDLE_MS, removeMember, rolesFor,
  setTrack, startChannel, sweepChannels, takeDecks, trust, untrust,
} from "./channels";

const NOW = 1_000_000;
const PAT = { email: "Pat@Example.com", name: "Pat", picture: null };
const ANNA = "anna@example.com";

function live(options: Record<string, unknown> = {}) {
  return startChannel(PAT, { djName: "DJ Pat", roomName: "friday bangers", trustedEmails: [ANNA], ...options }, NOW).channel;
}

beforeEach(() => channels.clear());

describe("startChannel", () => {
  test("creates a channel owned and DJed by the owner", () => {
    const { channel, created } = startChannel(PAT, { djName: " DJ Pat ", roomName: "  ", trustedEmails: [] }, NOW);
    expect(created).toBe(true);
    expect(channel.ownerEmail).toBe("pat@example.com");
    expect(channel.ownerName).toBe("DJ Pat");
    expect(channel.roomName).toBeNull();
    expect(channel.activeDjEmail).toBe("pat@example.com");
    expect(channels.get(channel.id)).toBe(channel);
  });

  test("going live again updates the same channel", () => {
    const first = live();
    const { channel, created } = startChannel(PAT, { djName: "Pat 2", roomName: "late night", trustedEmails: [] }, NOW + 1);
    expect(created).toBe(false);
    expect(channel.id).toBe(first.id);
    expect(channel.roomName).toBe("late night");
    expect(channels.size).toBe(1);
  });

  test("trusted list is normalized and never contains the owner", () => {
    const channel = live({ trustedEmails: ["ANNA@example.com", "pat@example.com", "not-an-email", 42] });
    expect([...channel.trustedEmails]).toEqual([ANNA]);
  });

  test("falls back to the owner's name and trims long names", () => {
    const channel = startChannel(PAT, { djName: "", roomName: "x".repeat(60) }, NOW).channel;
    expect(channel.ownerName).toBe("Pat");
    expect(channel.roomName).toHaveLength(40);
  });

  test("long owner name is clamped to 30 chars", () => {
    const longName = "A".repeat(60);
    const channel = startChannel({ email: "test@example.com", name: longName, picture: null }, { djName: "" }, NOW).channel;
    expect(channel.ownerName).toHaveLength(30);
    expect(channel.ownerName).toBe("A".repeat(30));
  });

  test("re-going-live: trusted DJ keeps decks, and the trusted list is unioned (not replaced)", () => {
    const channel = live({ trustedEmails: [ANNA] });
    takeDecks(channel, ANNA, "Anna");
    expect(channel.activeDjEmail).toBe(ANNA);
    expect(channel.activeDjName).toBe("Anna");

    // Re-go-live from a second device with a different trusted list - Anna is still trusted (union), keeps decks
    startChannel(PAT, { djName: "Pat", roomName: "room2", trustedEmails: ["max@example.com"] }, NOW + 1);
    expect(channel.activeDjEmail).toBe(ANNA);
    expect(channel.activeDjName).toBe("Anna");
    expect([...channel.trustedEmails].sort()).toEqual([ANNA, "max@example.com"]);

    // Re-go-live with an empty trusted list doesn't drop anyone - only live:untrust does
    startChannel(PAT, { djName: "Pat", roomName: "room3", trustedEmails: [] }, NOW + 2);
    expect(channel.activeDjEmail).toBe(ANNA);
    expect([...channel.trustedEmails].sort()).toEqual([ANNA, "max@example.com"]);

    // Only explicitly untrusting the active DJ sends the decks back to the owner
    untrust(channel, ANNA);
    expect(channel.activeDjEmail).toBe("pat@example.com");
    expect(channel.activeDjName).toBe("Pat");
  });

  test("trusted list is capped at 50 entries, ignoring extras", () => {
    const many = Array.from({ length: 55 }, (_, i) => `user${i}@example.com`);
    const channel = startChannel(PAT, { djName: "DJ", trustedEmails: many }, NOW).channel;
    expect(channel.trustedEmails.size).toBe(50);
  });

  test("going live again cannot grow the trusted list past 50", () => {
    const batch = (start: number) => Array.from({ length: 40 }, (_, i) => `user${start + i}@example.com`);
    startChannel(PAT, { djName: "DJ", trustedEmails: batch(0) }, NOW);
    const channel = startChannel(PAT, { djName: "DJ", trustedEmails: batch(100) }, NOW).channel;
    expect(channel.trustedEmails.size).toBe(50);
  });

  test("emails longer than 254 chars are ignored", () => {
    const long = `${"a".repeat(250)}@example.com`; // > 254 chars
    expect(long.length).toBeGreaterThan(254);
    const channel = live({ trustedEmails: [long, ANNA] });
    expect([...channel.trustedEmails]).toEqual([ANNA]);
  });
});

describe("roles", () => {
  test("only the owner sees the trusted list", () => {
    const channel = live();
    expect(rolesFor(channel, "pat@example.com")).toEqual({ isOwner: true, isTrusted: false, isActiveDj: true, trustedEmails: [ANNA] });
    expect(rolesFor(channel, ANNA)).toEqual({ isOwner: false, isTrusted: true, isActiveDj: false, trustedEmails: [] });
    expect(rolesFor(channel, null)).toEqual({ isOwner: false, isTrusted: false, isActiveDj: false, trustedEmails: [] });
  });

  test("trusted people and the owner can take the decks, others cannot", () => {
    const channel = live();
    expect(canTakeDecks(channel, ANNA)).toBe(true);
    expect(canTakeDecks(channel, "pat@example.com")).toBe(true);
    expect(canTakeDecks(channel, "max@example.com")).toBe(false);
    expect(canTakeDecks(channel, null)).toBe(false);

    takeDecks(channel, ANNA, "Anna");
    expect(channel.activeDjEmail).toBe(ANNA);
    expect(channel.activeDjName).toBe("Anna");

    takeDecks(channel, "pat@example.com", "ignored");
    expect(channel.activeDjName).toBe("DJ Pat");
  });

  test("trust adds once and refuses the owner", () => {
    const channel = live({ trustedEmails: [] });
    expect(trust(channel, "Max@Example.com")).toBe(true);
    expect(trust(channel, "max@example.com")).toBe(false);
    expect(trust(channel, "pat@example.com")).toBe(false);
    expect([...channel.trustedEmails]).toEqual(["max@example.com"]);
  });

  test("trust refuses overlong emails and more than 50 entries", () => {
    const channel = live({ trustedEmails: [] });
    const long = `${"a".repeat(250)}@example.com`;
    expect(trust(channel, long)).toBe(false);

    for (let i = 0; i < 50; i++) trust(channel, `user${i}@example.com`);
    expect(channel.trustedEmails.size).toBe(50);
    expect(trust(channel, "overflow@example.com")).toBe(false);
    expect(channel.trustedEmails.size).toBe(50);
  });

  test("untrusting the active DJ returns the decks to the owner", () => {
    const channel = live();
    takeDecks(channel, ANNA, "Anna");
    expect(untrust(channel, ANNA)).toBe(true);
    expect(channel.activeDjEmail).toBe("pat@example.com");
    expect(channel.trustedEmails.size).toBe(0);
    expect(untrust(channel, "max@example.com")).toBe(false);
  });

  test("long taker name is clamped to 30 chars", () => {
    const channel = live();
    const longName = "B".repeat(60);
    takeDecks(channel, ANNA, longName);
    expect(channel.activeDjName).toHaveLength(30);
    expect(channel.activeDjName).toBe("B".repeat(30));
  });
});

describe("members and DJ presence", () => {
  test("decks fall back to the owner when the active DJ leaves", () => {
    const channel = live();
    addMember(channel, "c-pat", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    addMember(channel, "c-anna", { name: "Anna", email: ANNA, connectedAt: NOW });
    takeDecks(channel, ANNA, "Anna");

    expect(removeMember(channel, "c-anna", NOW)).toBe(true);

    expect(channel.activeDjEmail).toBe("pat@example.com");
    expect(channel.activeDjGoneSince).toBeNull();
  });

  test("DJ is marked away when nobody can take over", () => {
    const channel = live();
    addMember(channel, "c-pat", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    expect(removeMember(channel, "c-pat", NOW + 5)).toBe(true);
    expect(channel.activeDjGoneSince).toBe(NOW + 5);
    expect(directory()[0].djAway).toBe(true);
  });

  test("a second device of the DJ keeps them present", () => {
    const channel = live();
    addMember(channel, "web", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    addMember(channel, "mac", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    expect(removeMember(channel, "web", NOW)).toBe(false);
    expect(channel.activeDjGoneSince).toBeNull();
  });

  test("returning DJ or owner clears the away state", () => {
    const channel = live();
    addMember(channel, "c-pat", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    removeMember(channel, "c-pat", NOW);
    expect(addMember(channel, "c-listener", { name: "Max", email: null, connectedAt: NOW })).toBe(false);
    expect(addMember(channel, "c-pat-2", { name: "DJ Pat", email: "PAT@example.com", connectedAt: NOW })).toBe(true);
    expect(channel.activeDjGoneSince).toBeNull();
  });

  test("owner DJ leaving doesn't give decks to trusted member", () => {
    const channel = live();
    addMember(channel, "c-pat", { name: "DJ Pat", email: "pat@example.com", connectedAt: NOW });
    addMember(channel, "c-anna", { name: "Anna", email: ANNA, connectedAt: NOW });

    // Owner (Pat) is the active DJ, Anna is trusted but doesn't have decks
    expect(channel.activeDjEmail).toBe("pat@example.com");
    expect(channel.activeDjName).toBe("DJ Pat");

    // Pat's connection leaves
    expect(removeMember(channel, "c-pat", NOW)).toBe(true);

    // Decks should go to away state, not to Anna
    expect(channel.activeDjGoneSince).toBe(NOW);
    expect(channel.activeDjEmail).toBe("pat@example.com"); // still the owner
    expect(channel.activeDjName).toBe("DJ Pat"); // name unchanged
  });
});

describe("sweepChannels", () => {
  test("ends a channel whose DJ has been gone for 2 minutes", () => {
    const channel = live();
    channel.activeDjGoneSince = NOW;
    expect(sweepChannels(NOW + DJ_GONE_MS - 1)).toEqual([]);
    expect(sweepChannels(NOW + DJ_GONE_MS)).toEqual([{ channel, reason: "dj-gone" }]);
    expect(channels.size).toBe(0);
  });

  test("ends a channel that played nothing for 10 minutes", () => {
    const channel = live();
    expect(sweepChannels(NOW + IDLE_MS - 1)).toEqual([]);
    expect(sweepChannels(NOW + IDLE_MS)).toEqual([{ channel, reason: "idle" }]);
  });

  test("playing keeps the channel alive", () => {
    const channel = live();
    setTrack(channel, "https://soundcloud.com/a/b", "B", null, "https://cf.sndcdn.com/x", NOW);
    expect(sweepChannels(NOW + IDLE_MS * 3)).toEqual([]);
    channel.isPlaying = false;
    expect(sweepChannels(NOW + IDLE_MS * 3 + IDLE_MS - 1)).toEqual([]);
    expect(sweepChannels(NOW + IDLE_MS * 4)).toHaveLength(1);
  });
});

describe("directory", () => {
  test("lists busiest channels first with public fields only", () => {
    const quiet = live();
    const busy = startChannel({ email: ANNA, name: "Anna", picture: "https://x/a.png" }, { roomName: "busy" }, NOW).channel;
    addMember(busy, "c1", { name: "A", email: null, connectedAt: NOW });
    addMember(busy, "c2", { name: "B", email: null, connectedAt: NOW });

    const entries = directory();

    expect(entries.map((e) => e.id)).toEqual([busy.id, quiet.id]);
    expect(entries[0]).toEqual({
      id: busy.id, ownerName: "Anna", ownerPicture: "https://x/a.png", roomName: "busy", activeDjName: "Anna",
      djAway: false, trackTitle: null, trackArtwork: null, isPlaying: false, listenerCount: 2,
    });
  });
});
