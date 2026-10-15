import { describe, expect, it } from "vitest";
import { SlackFormatConverter } from "@chat-adapter/slack";
import { resolveSlackPublicationMentions } from "./slack-publication-mentions.js";

const participants = [
  { externalId: "U0C9FSX8K5F", handle: "hi-dot", displayName: "Hi Dot" },
  { externalId: "W0SECOND", handle: "hi.dot" },
  { externalId: "U0SHORT", handle: "hi" },
];
const neutral = (name: string) => `@\u200b${name}`;

describe("Slack publication mention canonicalization", () => {
  it.each([
    ["@hi-dot", "<@U0C9FSX8K5F>"],
    ["@Hi Dot", "<@U0C9FSX8K5F>"],
    ["İstanbul: @hi-dot", "İstanbul: <@U0C9FSX8K5F>"],
    ["\\@hi-dot", `\\${neutral("hi-dot")}`],
    ["<@hi>-dot", `<${neutral("hi")}>-dot`],
    ["Thanks @HI-DOT!", "Thanks <@U0C9FSX8K5F>!"],
    ["@hi.dot and @hi", "<@W0SECOND> and <@U0SHORT>"],
    ["@hi-dot, @hi-dot.", "<@U0C9FSX8K5F>, <@U0C9FSX8K5F>."],
    ["@hi-dot-other", neutral("hi-dot-other")],
    ["@hi-dot.example", neutral("hi-dot.example")],
    ["@unknown @here", `${neutral("unknown")} ${neutral("here")}`],
    ["<@U0C9FSX8K5F> and @U0C9FSX8K5F", "<@U0C9FSX8K5F> and <@U0C9FSX8K5F>"],
  ])("resolves complete known aliases without inventing IDs: %s", (source, expected) => {
    const resolved = resolveSlackPublicationMentions(source, participants);
    expect(resolved).toBe(expected);
    expect(resolveSlackPublicationMentions(resolved, participants)).toBe(resolved);
    expect(new SlackFormatConverter().toSlackPayload({ markdown: resolved })).toEqual({ markdown_text: expected });
  });

  it("rejects an ambiguous alias but accepts duplicate observations of the same identity", () => {
    expect(resolveSlackPublicationMentions("@hi-dot", [participants[0]!, participants[0]!])).toBe("<@U0C9FSX8K5F>");
    expect(resolveSlackPublicationMentions("@hi-dot", [participants[0]!, { externalId: "U0IMPOSTOR", handle: "HI-DOT" }])).toBe(neutral("hi-dot"));
  });

  it("does not make mentions from invalid or absent Slack user identities", () => {
    for (const externalId of ["B0BOTID", "U-valid-looking", "", "<@U0INJECTED>"]) {
      expect(resolveSlackPublicationMentions("@hi-dot", [{ externalId, handle: "hi-dot" }])).toBe(neutral("hi-dot"));
    }
    expect(resolveSlackPublicationMentions("@hi-dot", [])).toBe(neutral("hi-dot"));
  });

  it.each([
    "`@hi-dot`", "``@hi-dot``", "```ts\n@hi-dot\n```", "~~~text\n@hi-dot\n~~~",
    "https://example.com/@hi-dot", "example.com/@hi-dot", "hi-dot@example.com",
    "[reference](https://example.com/@hi-dot)", "[reference](@hi-dot)",
    "<@U0C9FSX8K5F>", "<https://example.com|@hi-dot>",
  ])("preserves protected source regions byte-for-byte: %s", (source) => {
    expect(resolveSlackPublicationMentions(source, participants)).toBe(source);
  });

  it("resolves surrounding prose without changing protected code, destinations or emails", () => {
    const source = "Ask @hi-dot; see `@hi-dot`, [docs](https://example.com/@hi-dot) or hi-dot@example.com.";
    const expected = "Ask <@U0C9FSX8K5F>; see `@hi-dot`, [docs](https://example.com/@hi-dot) or hi-dot@example.com.";
    expect(resolveSlackPublicationMentions(source, participants)).toBe(expected);
    expect(new SlackFormatConverter().toSlackPayload({ markdown: expected })).toEqual({ markdown_text: expected });
  });

  it("bounds parsing of large prose and preserves oversized literal-rich source", () => {
    const ordinary = `${"prose ".repeat(170_000)}@hi-dot`;
    expect(resolveSlackPublicationMentions(ordinary, participants)).toBe(`${"prose ".repeat(170_000)}<@U0C9FSX8K5F>`);
    for (const marker of ["[", "<"]) {
      const literal = `${marker.repeat(1_000_000)} @hi-dot`;
      expect(resolveSlackPublicationMentions(literal, participants)).toBe(literal);
    }
  }, 10_000);
});
