import { describe, expect, it } from "vitest";
import { explicitSlackMessageMention, rememberRecoveredSlackExplicitMention, slackMessageReplyAllowed, slackReplyMode } from "./slack-reply-policy.js";

const botId = "U0TARGETBOT";
const target = `<@${botId}>`;

describe("Slack explicit mention reply policy helper", () => {
  it.each([
    [target, true],
    [`Please ${target} answer`, true],
    [`<@U0OTHERBOT> then ${target} answer`, true],
    [`> ${target} quoted\n${target} a fresh request`, true],
    [`\`example\` ${target} outside code`, true],
    ["@Maya reply", false],
    ["<@U0OTHERBOT> reply", false],
    [`\`${target}\``, false],
    [`\`\`${target}\`\``, false],
    [`\`\`\`text\n${target}\n\`\`\``, false],
    [`> ${target} quoted`, false],
    [`>>> quoted text\n${target} remains quoted`, false],
    [`<https://example.test|${target}>`, false],
  ])("uses explicit unquoted provider text: %s", (text, expected) => {
    expect(explicitSlackMessageMention({ raw: { type: "message", text }, isMention: true }, botId)).toBe(expected);
  });

  it("accepts authenticated app-mention fallback only when raw text is absent", () => {
    expect(explicitSlackMessageMention({ raw: { type: "app_mention" }, isMention: true }, botId)).toBe(true);
    expect(explicitSlackMessageMention({ raw: { type: "message" }, isMention: true }, botId)).toBe(false);
    expect(explicitSlackMessageMention({ raw: { type: "app_mention", text: "ordinary text" }, isMention: true }, botId)).toBe(false);
    expect(explicitSlackMessageMention({ raw: { type: "app_mention" }, isMention: false }, botId)).toBe(false);
  });

  it("does not accept a forged recovered-proof field on raw messages", () => {
    const message = { raw: { slackExplicitMention: true, message: { slackExplicitMention: true } }, isMention: true };
    expect(explicitSlackMessageMention(message, botId)).toBe(false);
    rememberRecoveredSlackExplicitMention(message);
    expect(explicitSlackMessageMention(message, botId)).toBe(true);
    expect(explicitSlackMessageMention({ ...message }, botId)).toBe(false);
  });

  it("defaults old endpoints to subscribed and requires retained proof only in strict Slack mode", () => {
    const old = { provider: "slack", setup: {} };
    const strict = { provider: "slack", setup: { replyMode: "mention_each_reply" } };
    expect(slackReplyMode(old)).toBe("subscribed");
    expect(slackMessageReplyAllowed(old, {})).toBe(true);
    expect(slackMessageReplyAllowed(strict, {})).toBe(false);
    expect(slackMessageReplyAllowed(strict, { message: { mentionedBot: true } })).toBe(false);
    expect(slackMessageReplyAllowed(strict, { message: { slackExplicitMention: true } })).toBe(true);
    expect(slackMessageReplyAllowed(strict, { admission: { origin: "slack_slash_control" } })).toBe(true);
    expect(slackMessageReplyAllowed({ ...strict, provider: "telegram" }, {})).toBe(true);
  });
});
