import { parseMarkdown } from "chat";
import { splitNativePublicationText } from "./chat-publication-text-parts.js";

type SlackMentionParticipant = {
  externalId: string;
  handle?: string | null;
  displayName?: string | null;
};

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,63}$/;
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/;
const NAME_CHARACTER = /[\p{L}\p{N}_.-]/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const PROTECTED_MARKDOWN = new Set([
  "code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "definition",
]);

/** Resolve only existing references to verified participants, never add a mention.
 * Unknown names stay readable but cannot enter the SDK's bare-name resolver,
 * which otherwise turns e.g. @hi-dot into the invalid Slack entity <@hi>-dot.
 */
export function resolveSlackPublicationMentions(
  text: string,
  participants: readonly SlackMentionParticipant[],
): string {
  if (!text.includes("@")) return text;
  if (text.length > 16_000) {
    // Reuse the transport's bounded Markdown parsing and protective code
    // wrappers. Never hand a potentially million-character rich block to the
    // Markdown parser while holding a publication lock. Rejoin source bytes;
    // the caller splits again after mention expansion for actual delivery.
    return splitNativePublicationText("slack", text).map((part) => {
      const prefix = part.prefix ?? "";
      const suffix = part.suffix ?? "";
      const resolved = resolveSlackPublicationMentions(`${prefix}${part.text}${suffix}`, participants);
      return resolved.slice(prefix.length, suffix.length ? -suffix.length : undefined);
    }).join("");
  }
  const aliases = new Map<string, Set<string>>();
  for (const participant of participants) {
    if (!SLACK_USER_ID.test(participant.externalId)) continue;
    for (const rawAlias of [participant.externalId, participant.handle, participant.displayName]) {
      const alias = rawAlias?.trim();
      if (!alias || !ALIAS.test(alias)) continue;
      const key = alias.toLowerCase();
      const ids = aliases.get(key) ?? new Set<string>();
      ids.add(participant.externalId);
      aliases.set(key, ids);
    }
  }
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);

  const replaceText = (source: string): string => {
    let result = "";
    let index = 0;
    let nextAngleEnd = source.indexOf(">");
    let nextLineEnd = source.indexOf("\n");
    // ASCII aliases preserve source offsets even when surrounding Unicode has
    // a case-folding expansion (for example capital dotted I).
    const lowerSource = source.replace(/[A-Z]/g, (character) => character.toLowerCase());
    while (index < source.length) {
      // Slack entities, autolinks, and email/URL angle brackets are already
      // explicit syntax. Do not reinterpret their contents as display names.
      if (source[index] === "<") {
        if (nextAngleEnd >= 0 && nextAngleEnd < index) nextAngleEnd = source.indexOf(">", index + 1);
        if (nextLineEnd >= 0 && nextLineEnd < index) nextLineEnd = source.indexOf("\n", index + 1);
        const end = nextAngleEnd;
        if (end >= 0 && (nextLineEnd < 0 || end < nextLineEnd)) {
          const entity = source.slice(index, end + 1);
          result += /^<@[^>]+>$/.test(entity) && !entity.startsWith("<@\u200b") && !/^<@[UW][A-Z0-9]{2,63}>$/.test(entity)
            ? entity.replace("@", "@\u200b")
            : entity;
          index = end + 1;
          continue;
        }
      }
      // Preserve non-autolinked URLs too. The SDK protects these independently
      // of Markdown parsing; rewriting their path could change the destination.
      const url = (index === 0 || !NAME_CHARACTER.test(source[index - 1]!))
        ? /^(?:https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?=[/?#]))[^\s<>]*/i.exec(source.slice(index))
        : null;
      if (url) {
        result += url[0];
        index += url[0].length;
        continue;
      }
      const previous = source[index - 1];
      if (source[index] !== "@" || (previous && (WORD_CHARACTER.test(previous) || previous === "<"))) {
        result += source[index++];
        continue;
      }
      const rest = source.slice(index + 1);
      // Zero-width separation is intentional and makes durable retries
      // idempotent even if the set of conversation participants changes.
      if (!rest || !WORD_CHARACTER.test(rest[0]!)) {
        result += source[index++];
        continue;
      }
      let matched: string | undefined;
      // A backslash-escaped name is literal prose, not a request to notify.
      let slashCount = 0;
      for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) slashCount++;
      if (slashCount % 2 === 0) {
        matched = names.find((name) => {
          if (!lowerSource.startsWith(name, index + 1)) return false;
          const after = rest.slice(name.length);
          // Allow sentence-ending dots, but never match a prefix of a longer
          // handle, domain, or hyphenated name.
          return !after || !NAME_CHARACTER.test(after[0]!) || /^\.+(?:$|[^\p{L}\p{N}_.-])/u.test(after);
        });
      }
      const ids = matched ? aliases.get(matched)! : null;
      if (matched && ids?.size === 1) {
        result += `<@${[...ids][0]}>`;
        index += matched.length + 1;
      } else {
        result += "@\u200b";
        index++;
      }
    }
    return result;
  };

  // Use parser positions rather than stringify: protected Markdown and every
  // byte outside an actual prose text node retain the author's formatting.
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: MarkdownNode) => {
    if (PROTECTED_MARKDOWN.has(node.type)) return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start === "number" && typeof end === "number") ranges.push({ start, end });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parseMarkdown(text) as MarkdownNode);
  let result = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    result += text.slice(cursor, start) + replaceText(text.slice(start, end));
    cursor = end;
  }
  return result + text.slice(cursor);
}
