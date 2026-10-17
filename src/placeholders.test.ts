import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("URL placeholders", () => {
  test("the script that overwrites the queue field names the room's source", () => {
    const radio = read("public/radio.js");
    const start = radio.indexOf("function renderQueueAccess");
    const end = radio.indexOf("queueTrustedOnly.addEventListener");
    const block = radio.slice(start, end);

    expect(block).toContain("const source = sourceLabel(currentSource())");
    expect(block).toContain("trackUrlInput.placeholder = `Paste ${source} URL...`");
    expect(block).toContain("`Sign in to add a ${source} URL`");
    expect(block).toContain("`Add ${source} URL to queue...`");
    expect(block).toContain("`Only trusted DJs can add ${source} tracks here`");
    // A room plays from one source, so the fields must never name both.
    expect(block).not.toContain("SoundCloud or Suno");
    expect(block).not.toContain("Sign in to add tracks");
  });

  test("the HTML fallback and the Mac fields follow the room's source", () => {
    const html = read("public/index.html");
    const mac = read("macos/VibezMac/Sources/NowPlayingView.swift");

    // The HTML attributes are only the pre-JS fallback, so they name the default source.
    expect(html).toContain('placeholder="Paste SoundCloud URL..."');
    expect(html).toContain('placeholder="Add SoundCloud URL to queue..."');
    expect(html).not.toContain("SoundCloud or Suno");
    expect(mac).toContain('TextField("\\(roomSource.label) URL…"');
    expect(mac).toContain('TextField("Add \\(roomSource.label) URL to queue…"');
    expect(mac).not.toContain("SoundCloud or Suno");
  });

  test("both clients offer the source picker and ask for a Suno token", () => {
    const html = read("public/index.html");
    const radio = read("public/radio.js");
    const mac = read("macos/VibezMac/Sources/NowPlayingView.swift");

    expect(html).toContain('<select id="sourceSelect">');
    expect(html).toContain('id="sunoTokenInput"');
    expect(radio).toContain('type: "room:source"');
    expect(mac).toContain("sourcePicker");
    expect(mac).toContain("SecureField");
  });
});
