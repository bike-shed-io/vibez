import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("URL placeholders", () => {
  test("the script that overwrites the queue field names every source", () => {
    const radio = read("public/radio.js");
    const start = radio.indexOf("function renderQueueAccess");
    const end = radio.indexOf("queueTrustedOnly.addEventListener");
    const block = radio.slice(start, end);

    expect(block).toContain('trackUrlInput.placeholder = "Paste SoundCloud, Suno or YouTube URL..."');
    expect(block).toContain('"Sign in to add a SoundCloud, Suno or YouTube URL"');
    expect(block).toContain('"Add SoundCloud, Suno or YouTube URL to queue..."');
    expect(block).toContain('"Only trusted DJs can add SoundCloud, Suno or YouTube tracks here"');
    expect(block).not.toContain("Add SoundCloud URL to queue...");
    expect(block).not.toContain("Sign in to add tracks");
  });

  test("the HTML fallback and the Mac fields name every source", () => {
    const html = read("public/index.html");
    const mac = read("macos/VibezMac/Sources/NowPlayingView.swift");

    expect(html).toContain('placeholder="Paste SoundCloud, Suno or YouTube URL..."');
    expect(html).toContain('placeholder="Add SoundCloud, Suno or YouTube URL to queue..."');
    expect(mac).toContain('TextField("SoundCloud, Suno or YouTube URL…"');
    expect(mac).toContain('TextField("Add SoundCloud, Suno or YouTube URL to queue…"');
  });
});
