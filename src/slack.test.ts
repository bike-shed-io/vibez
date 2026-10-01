import { describe, expect, test } from "bun:test";
import { channelListMessage, radioCommandUsage, SLACK_COMMANDS } from "./slack";

const entry = {
  id: "abc123", ownerName: "Pat", ownerPicture: null, roomName: null, activeDjName: "Anna",
  djAway: false, trackTitle: "Song <b>", trackArtwork: null, isPlaying: true, listenerCount: 3,
};

describe("Slack commands", () => {
  test("registers /vibez and legacy /radio commands", () => {
    expect(SLACK_COMMANDS).toEqual(["/vibez", "/radio"]);
  });

  test("usage explains that play and queue are on hold", () => {
    const usage = radioCommandUsage("/vibez");
    expect(usage).toContain("`/vibez` — list live channels");
    expect(usage).toContain("https://github.com/bike-shed-io/vibez/issues/8");
  });

  test("lists live channels with listen buttons", () => {
    const message = channelListMessage([entry], "https://vibez.bike-shed.io");
    const section = message.blocks![0] as any;
    expect(section.text.text).toBe("*Pat's vibes* — Pat (🎧 Anna)\n:musical_note: Song &lt;b&gt; · 3 listening");
    const actions = message.blocks![1] as any;
    expect(actions.elements.map((element: any) => element.url)).toEqual([
      "vibez://channel/abc123",
      "https://vibez.bike-shed.io/c/abc123",
    ]);
  });

  test("says when nobody is live", () => {
    expect(channelListMessage([], "https://x").text).toBe("Nobody's live right now. Open Vibez to go live.");
  });

  test("caps the list at 25 channels and notes how many more are live", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...entry, id: `c${i}` }));
    const message = channelListMessage(many, "https://x");
    expect(message.blocks).toHaveLength(25 * 2 + 1);
    const last = message.blocks![message.blocks!.length - 1] as any;
    expect(last).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "…and 5 more live on Vibez" }] });
    expect(message.text).toBe("30 live on Vibez");
  });
});
