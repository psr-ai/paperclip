export const SLACK_EXPLICIT_MENTION_REQUIRED = "This Slack connection requires an explicit mention for every message";

type ReplyPolicyEndpoint = { provider: string; setup: { replyMode?: unknown } };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function slackReplyMode(endpoint: ReplyPolicyEndpoint): "subscribed" | "mention_each_reply" {
  return endpoint.provider === "slack" && endpoint.setup.replyMode === "mention_each_reply"
    ? "mention_each_reply" : "subscribed";
}

const recoveredMentions = new WeakSet<object>();
export function rememberRecoveredSlackExplicitMention(message: object) {
  recoveredMentions.add(message);
}

/** Provider-authenticated input only. Names, implicit DMs, quoted examples and
 * code are not explicit invocations of the connected Slack user. */
export function explicitSlackMessageMention(
  message: { raw: unknown; isMention?: boolean },
  botUserId: string | null,
): boolean {
  if (!botUserId) return false;
  if (recoveredMentions.has(message)) return true;
  const raw = record(message.raw);
  if (typeof raw.text !== "string") return raw.type === "app_mention" && message.isMention === true;
  const text = raw.text;
  const target = `<@${botUserId}>`;
  let fenced = false;
  let inline = false;
  let lineStart = true;
  for (let index = 0; index < text.length;) {
    if (lineStart) {
      let start = index;
      while (text[start] === " " || text[start] === "\t") start++;
      if (text[start] === ">") {
        if (text.startsWith(">>>", start)) return false;
        const end = text.indexOf("\n", start);
        if (end < 0) return false;
        index = end + 1;
        continue;
      }
      lineStart = false;
    }
    if (text[index] === "\n") { lineStart = true; inline = false; index++; continue; }
    if (text[index] === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      if (end - index >= 3) { fenced = !fenced; inline = false; }
      else if (!fenced) inline = !inline;
      index = end;
      continue;
    }
    if (!fenced && !inline && text[index] === "<") {
      if (text.startsWith(target, index)) return true;
      const end = text.indexOf(">", index + 1);
      if (end >= 0) { index = end + 1; continue; }
      // No further closing entity can contain a valid canonical mention.
      return false;
    }
    index++;
  }
  return false;
}

/** Re-evaluate retained source against the current endpoint setting. A slash
 * command is a deliberate invocation on its separately authenticated surface. */
export function slackMessageReplyAllowed(endpoint: ReplyPolicyEndpoint, normalized: unknown): boolean {
  if (slackReplyMode(endpoint) !== "mention_each_reply") return true;
  const event = record(normalized);
  if (isSlackSlashControlDelivery(event)) return true;
  return record(event.message).slackExplicitMention === true;
}

export function isSlackSlashControlDelivery(normalized: unknown): boolean {
  return record(record(normalized).admission).origin === "slack_slash_control";
}
