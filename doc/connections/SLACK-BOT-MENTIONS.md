# Authorized Slack bot mentions

## Mention-only replies

In Apps → the Slack connection → Settings, enable **Require an @mention for
every message** to select `mention_each_reply`. The same authenticated endpoint
API accepts:

```json
{ "replyMode": "mention_each_reply" }
```

Every ordinary Slack message must then explicitly mention that connection's bot,
including replies in existing task threads and direct messages. A plain display
name, another bot's mention, or a mention inside code or quoted text does not
start work. The setting is enforced before task comments and agent wakeups, and
rechecked for retained work and replies when the setting changes. Old ignored
messages are not replayed. Existing warm human sessions and their scheduling
behavior are retained.

`subscribed` is the backward-compatible default: an initial mention starts a
channel task, subsequent thread replies may continue it without another mention,
and enabled DMs may start or continue work. The setting applies only to Slack;
channel access, human identity checks, bot allowlists, and bot reply budgets
continue to apply independently. Deliberate slash commands, buttons, and other
authenticated control actions remain explicit invocations and do not require an
extra mention. It does not cancel an already executing model request.

## Authorizing other bots

Slack endpoints ignore other bots by default. An endpoint administrator can
authorize a specific Slack bot user in a specific channel to request a turn from
the assigned agent. This is a machine grant sponsored by the endpoint's active
Paperclip operator; it does not link the bot to a human account.

Configure the existing authenticated endpoint API:

```http
PATCH /api/chat-endpoints/<endpoint-id>
Content-Type: application/json
```

```json
{
  "slackBotMessages": {
    "allowlist": [
      { "botUserId": "U0123456789", "channelId": "C0123456789" }
    ]
  }
}
```

Use immutable Slack bot **user** and channel IDs, not display names or app IDs.
The endpoint is already scoped to its Slack workspace and Paperclip company.
The channel must remain enabled. An empty allowlist disables bot admission.
The current management UI does not edit this setting; it is available through
the endpoint API. Existing human identity linking and guest settings are unchanged.

An admitted message must explicitly mention the receiving bot. Direct messages,
self-messages, system events, and implicit thread-follow-up triggers do not gain
bot admission. The bot remains a bot in durable receipts and recovered deliveries.
Its task comment and wake are attributed to the external machine principal, not
to the sponsoring human. New work uses the sponsor's responsibility; a bot cannot
take over an existing thread belonging to a different responsible user.

The explicit machine grant uses the assigned agent's existing execution policy.
It does not add the unlinked-human guest quarantine to an otherwise authorized
thread, and it never removes an existing trust restriction. It does not authorize
human-only controls, approvals, identity linking, or a human Slack user's search
and tool privileges. Normal task, agent, connection, and approval restrictions
continue to apply.

Admission is limited to three bot turns per original Slack thread and ten per
endpoint in a rolling minute. The limits are durable and checked under the
endpoint's transaction lock. Duplicate deliveries do not consume additional
turns. The thread limit spans conversation/session generations. Start a new
thread for further planned collaboration after the limit; changing the provider
message ID in the same thread does not reset it.

Policy, sponsor membership, and channel reach are rechecked at execution and
publication boundaries. Removing the grant prevents queued work from gaining
authority from a stale receipt. Previously ignored messages are not automatically
replayed when the grant is added; send a fresh explicit mention after enabling it.

Replies retain the sender's immutable Slack user ID in the task's `Reply mention`
metadata. Use that exact `<@USER_ID>` syntax when a reply should notify the sender.
Before delivery, Paperclip also resolves existing bare references such as
`@hi-dot` to a unique known participant of that same company, Slack endpoint,
workspace, and conversation. Only processed inbound participants are eligible;
no workspace-wide name guessing or automatic mention insertion occurs.
Ambiguous and unknown bare names remain plain text. The resolved publication is
saved before message splitting and retries, so posting, editing, and streaming
use the same ID even if a display name later changes. Code, links, URLs, and email
addresses are not rewritten by this resolution step.

For Slack event identity details, see the official
[bot message event documentation](https://docs.slack.dev/reference/events/message/bot_message/).
