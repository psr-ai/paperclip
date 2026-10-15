import { updateChatEndpointSchema } from "@paperclipai/shared";

export const SLACK_BOT_THREAD_TURN_LIMIT = 8;
export const SLACK_BOT_ENDPOINT_MINUTE_LIMIT = 10;
export const SLACK_BOT_MESSAGE_DENIED = "Slack bot message is not authorized";
export const SLACK_BOT_BUDGET_EXHAUSTED = "Slack bot reply budget exhausted";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

// Only the durable-delivery rehydrator may restore this verified fact. Raw
// provider text is not retained merely to reconstruct a mention after restart.
const recoveredMentions = new WeakSet<object>();
export function rememberRecoveredSlackBotMention(message: object) {
  recoveredMentions.add(message);
}

export function explicitSlackBotMention(message: { raw: unknown; isMention?: boolean }, botUserId: string | null): boolean {
  if (!botUserId) return false;
  if (recoveredMentions.has(message)) return true;
  const raw = record(message.raw);
  return (typeof raw.text === "string" && raw.text.includes(`<@${botUserId}>`)) ||
    (raw.type === "app_mention" && message.isMention === true);
}

export function isSlackBotEvent(normalized: unknown): boolean {
  return record(record(normalized).principal).isBot === true;
}

export function slackBotMessageAllowed(endpoint: {
  provider: string; status: string; sponsorUserId: string | null;
  botExternalId: string | null; setup: { slackBotMessages?: unknown };
}, normalized: unknown): boolean {
  if (endpoint.provider !== "slack" || endpoint.status !== "active" || !endpoint.sponsorUserId) return false;
  const event = record(normalized);
  const principal = record(event.principal);
  const resource = record(event.resource);
  const conversation = record(event.conversation);
  if (principal.isBot !== true || principal.externalId === endpoint.botExternalId ||
      conversation.isDirectMessage !== false || record(event.message).slackBotMentioned !== true) return false;
  const parsed = updateChatEndpointSchema.safeParse({ slackBotMessages: endpoint.setup.slackBotMessages });
  return parsed.success && Boolean(parsed.data.slackBotMessages?.allowlist.some(
    (entry) => entry.botUserId === principal.externalId && entry.channelId === resource.providerResourceId,
  ));
}
