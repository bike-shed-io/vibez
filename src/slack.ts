import { App } from "@slack/bolt";
import { directory, type DirectoryEntry } from "./channels";
import { escapeSlack, listenUrls } from "./notifications";

export const SLACK_COMMANDS = ["/vibez", "/radio"];
const ON_HOLD_ISSUE = "https://github.com/bike-shed-io/vibez/issues/8";

export function radioCommandUsage(commandName: string) {
  return `Usage:
• \`${commandName}\` — list live channels
• \`${commandName} help\` — this message
Playing and queueing from Slack is on hold while Vibez moves to channels: ${ON_HOLD_ISSUE}`;
}

type SlackResponse = { response_type: "ephemeral"; text: string; blocks?: Array<Record<string, unknown>> };

// Each channel renders as 2 blocks; Slack caps messages at 50 blocks. When truncating,
// one block goes to the "…and N more" line, so only 24 channels fit.
const MAX_LISTED_CHANNELS = 25;

export function channelListMessage(entries: DirectoryEntry[], radioUrl: string): SlackResponse {
  if (entries.length === 0) {
    return { response_type: "ephemeral", text: "Nobody's live right now. Open Vibez to go live." };
  }
  const shown = entries.slice(0, entries.length > MAX_LISTED_CHANNELS ? MAX_LISTED_CHANNELS - 1 : MAX_LISTED_CHANNELS);
  const blocks: Array<Record<string, unknown>> = shown.flatMap((entry) => {
    const room = escapeSlack(entry.roomName ?? `${entry.ownerName}'s vibes`);
    const dj = entry.activeDjName !== entry.ownerName ? ` (🎧 ${escapeSlack(entry.activeDjName)})` : "";
    const track = entry.trackTitle ? `:musical_note: ${escapeSlack(entry.trackTitle)}` : "_Nothing playing_";
    const urls = listenUrls(radioUrl, entry.id);
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${room}* — ${escapeSlack(entry.ownerName)}${dj}\n${track} · ${entry.listenerCount} listening` },
        ...(entry.trackArtwork
          ? { accessory: { type: "image", image_url: entry.trackArtwork, alt_text: entry.trackTitle ?? "Artwork" } }
          : {}),
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Listen in app" }, url: urls.app, action_id: `listen_app_${entry.id}` },
          { type: "button", text: { type: "plain_text", text: "Listen on web" }, url: urls.web, action_id: `listen_web_${entry.id}` },
        ],
      },
    ];
  });
  const remaining = entries.length - shown.length;
  if (remaining > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `…and ${remaining} more live on Vibez` }] });
  }
  return { response_type: "ephemeral", text: `${entries.length} live on Vibez`, blocks };
}

let slackApp: InstanceType<typeof App> | null = null;

export async function startSlack() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.log("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set — Slack integration disabled");
    return;
  }

  slackApp = new App({ token: botToken, appToken, socketMode: true });

  const handleCommand = async ({ command, ack, respond }: any) => {
    await ack();
    const commandName = command.command || "/vibez";
    const sub = command.text.trim().split(/\s+/)[0]?.toLowerCase() || "list";
    const radioUrl = process.env.RADIO_URL || "http://localhost:3000";

    switch (sub) {
      case "play":
      case "queue":
      case "stop":
        await respond({
          response_type: "ephemeral",
          text: `:pause_button: \`${commandName} ${sub}\` is on hold while Vibez moves to channels: ${ON_HOLD_ISSUE}`,
        });
        return;
      case "help":
        await respond(radioCommandUsage(commandName));
        return;
      default:
        await respond(channelListMessage(directory(), radioUrl));
    }
  };

  for (const commandName of SLACK_COMMANDS) {
    slackApp.command(commandName, handleCommand);
  }

  // Link buttons still send an action that Slack wants acknowledged
  slackApp.action(/^(listen_|open_vibez|tune_in)/, async ({ ack }) => {
    await ack();
  });

  await slackApp.start();
  console.log("[slack] Slack bot connected in Socket Mode");
}
