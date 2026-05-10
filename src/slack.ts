import { App } from "@slack/bolt";
import { station, getSnapshot, listenerCount, listenerNames, claimDj, releaseDj } from "./station";
import { playFromSlack, queueFromSlack } from "./ws";

export const SLACK_COMMANDS = ["/vibez", "/radio"];

export function radioCommandUsage(commandName: string) {
  return `Usage:
• \`${commandName} play <soundcloud-url>\` — play a track
• \`${commandName} queue <soundcloud-url>\` — add a track to the queue
• \`${commandName} queue\` — show the current queue
• \`${commandName} stop\` — stop the radio
• \`${commandName} np\` — now playing
• \`${commandName} listeners\` — who's tuned in`;
}

let slackApp: InstanceType<typeof App> | null = null;

export async function startSlack() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.log("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set — Slack integration disabled");
    return;
  }

  slackApp = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  const handleCommand = async ({ command, ack, respond }: any) => {
    await ack();

    const commandName = command.command || "/vibez";
    const args = command.text.trim().split(/\s+/);
    const sub = args[0]?.toLowerCase() || "help";
    const radioUrl = process.env.RADIO_URL || "http://localhost:3000";

    switch (sub) {
      case "play": {
        const url = args[1];
        if (!url) {
          await respond(`Usage: \`${commandName} play <soundcloud-url>\``);
          return;
        }

        if (!station.djId) {
          claimDj(`slack:${command.user_id}`, command.user_name);
        }

        const { title, artwork, count } = await playFromSlack(url, command.user_name);
        const playLabel = count > 1
          ? `*${title || "Unknown Track"}* (playlist — ${count} tracks)`
          : `*${title || "Unknown Track"}*`;

        await respond({
          response_type: "in_channel",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:radio: *Now Playing on Team Radio*\n${playLabel}\nDJ: ${station.djName || command.user_name}`,
              },
              ...(artwork
                ? {
                    accessory: {
                      type: "image",
                      image_url: artwork,
                      alt_text: title || "Track artwork",
                    },
                  }
                : {}),
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Tune In" },
                  url: radioUrl,
                  action_id: "tune_in",
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${listenerCount()} listener${listenerCount() === 1 ? "" : "s"} tuned in`,
                },
              ],
            },
          ],
        });
        break;
      }

      case "stop": {
        releaseDj();
        await respond({ response_type: "in_channel", text: ":octagonal_sign: Team Radio stopped." });
        break;
      }

      case "np":
      case "nowplaying": {
        if (!station.trackUrl) {
          await respond("Nothing is playing right now. Use `/radio play <url>` to start.");
          return;
        }
        await respond({
          response_type: "ephemeral",
          text: `:radio: *${station.trackTitle || "Unknown Track"}*\nDJ: ${station.djName || "Unknown"}\n${listenerCount()} listener${listenerCount() === 1 ? "" : "s"}\n<${radioUrl}|Tune In>`,
        });
        break;
      }

      case "listeners": {
        const names = listenerNames();
        if (names.length === 0) {
          await respond("No one is tuned in right now.");
          return;
        }
        await respond({
          response_type: "ephemeral",
          text: `:headphones: ${names.length} tuned in: ${names.join(", ")}`,
        });
        break;
      }

      case "queue": {
        const url = args[1];
        if (!url) {
          if (station.queue.length === 0) {
            await respond({ response_type: "ephemeral", text: `The queue is empty. Use \`${commandName} queue <soundcloud-url>\` to add a track.` });
            return;
          }
          const lines = station.queue.map((item, i) =>
            `${i + 1}. *${item.title || "Unknown Track"}* — added by ${item.addedBy}`
          );
          await respond({
            response_type: "ephemeral",
            text: `:musical_note: *Queue (${station.queue.length} track${station.queue.length === 1 ? "" : "s"})*\n${lines.join("\n")}`,
          });
          return;
        }

        const { title, artwork, position, count } = await queueFromSlack(url, command.user_name);
        const queueLabel = count > 1
          ? `*${title || "Unknown Track"}* (playlist — ${count} tracks queued)`
          : `*${title || "Unknown Track"}* — #${position} in queue`;

        await respond({
          response_type: "in_channel",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:musical_note: *Queued on Team Radio*\n${queueLabel}\nAdded by ${command.user_name}`,
              },
              ...(artwork
                ? {
                    accessory: {
                      type: "image",
                      image_url: artwork,
                      alt_text: title || "Track artwork",
                    },
                  }
                : {}),
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Tune In" },
                  url: radioUrl,
                  action_id: "tune_in",
                },
              ],
            },
          ],
        });
        break;
      }

      default:
        await respond(radioCommandUsage(commandName));
    }
  };

  for (const commandName of SLACK_COMMANDS) {
    slackApp.command(commandName, handleCommand);
  }

  // Handle the "Tune In" button action (Slack requires an ack)
  slackApp.action("tune_in", async ({ ack }) => {
    await ack();
  });

  await slackApp.start();
  console.log("[slack] Slack bot connected in Socket Mode");
}
