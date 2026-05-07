import { describe, expect, test } from "bun:test";
import { radioCommandUsage, SLACK_COMMANDS } from "./slack";

describe("Slack command registration", () => {
  test("registers /vibez and legacy /radio commands", () => {
    expect(SLACK_COMMANDS).toEqual(["/vibez", "/radio"]);
  });

  test("renders usage with the invoked command name", () => {
    expect(radioCommandUsage("/vibez")).toContain("/vibez queue <soundcloud-url>");
    expect(radioCommandUsage("/radio")).toContain("/radio queue <soundcloud-url>");
  });
});
