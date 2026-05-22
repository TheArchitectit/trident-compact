import {
  Session,
  ConversationMessage,
  ContentBlock,
  MessageRole,
  clone_session,
  text_from_blocks,
  has_tool_use,
  tool_names_from_blocks,
  extract_file_paths,
} from "./session.js";

const COMPACT_CONTINUATION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_DIRECT_RESUME_INSTRUCTION =
  "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

export interface CompactionConfig {
  preserve_recent_messages: number;
  max_estimated_tokens: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactionConfig = {
  preserve_recent_messages: 4,
  max_estimated_tokens: 128_000,
};

export interface CompactionResult {
  summary: string;
  compacted_session: Session;
  removed_message_count: number;
}

// ---------- token estimation ----------

export function estimate_tokens(blocks: ContentBlock[]): number {
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        tokens += Math.ceil(block.text.length / 4) + 1;
        break;
      case "thinking":
        tokens += Math.ceil(block.thinking.length / 4) + 1;
        if (block.signature) {
          tokens += Math.ceil(block.signature.length / 4) + 1;
        }
        break;
      case "tool_use": {
        const input_str = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
        tokens += Math.ceil(input_str.length / 4) + 1;
        break;
      }
      case "tool_result":
        tokens += Math.ceil(block.output.length / 4) + 1;
        break;
    }
  }
  return tokens;
}

export function estimate_message_tokens(msg: ConversationMessage): number {
  return estimate_tokens(msg.content);
}

export function estimate_session_tokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, m) => sum + estimate_message_tokens(m), 0);
}

// ---------- should compact ----------

export function should_compact(session: Session, config: CompactionConfig): boolean {
  if (config.max_estimated_tokens === 0) return true;
  return estimate_session_tokens(session.messages) > config.max_estimated_tokens;
}

// ---------- boundary repair ----------

export function find_compaction_boundary(
  messages: ConversationMessage[],
  preserve_recent: number,
): number {
  if (preserve_recent === 0) return messages.length;

  let keep_from = Math.max(0, messages.length - preserve_recent);

  // Walk backward if the first preserved message is a ToolResult whose
  // paired ToolUse is in the removed section — keeps message pairs intact.
  while (keep_from > 0) {
    const first_preserved = messages[keep_from];
    if (!first_preserved) break;

    const is_tool_result =
      first_preserved.role === MessageRole.Tool ||
      first_preserved.content.some((b) => b.type === "tool_result");

    if (!is_tool_result) break;

    // Check if the preceding message has a matching tool_use
    const prev = messages[keep_from - 1];
    if (!prev) break;

    const prev_has_tool_use = has_tool_use(prev.content);
    if (prev_has_tool_use) break;

    keep_from--;
  }

  return keep_from;
}

// ---------- summarization helpers ----------

function summarize_block(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return block.text.length > 160 ? block.text.slice(0, 156) + "..." : block.text;
    case "thinking":
      return `thinking (${block.thinking.length} chars)`;
    case "tool_use":
      return `called ${block.name}`;
    case "tool_result":
      return block.is_error
        ? `error from ${block.tool_name}: ${(block.output.length > 80 ? block.output.slice(0, 76) + "..." : block.output)}`
        : `${block.tool_name} result (${block.output.length} chars)`;
  }
}

export function collect_recent_role_summaries(
  messages: ConversationMessage[],
  max_count: number,
): string[] {
  const user_msgs: string[] = [];
  for (let i = messages.length - 1; i >= 0 && user_msgs.length < max_count; i--) {
    if (messages[i].role === MessageRole.User) {
      const text = text_from_blocks(messages[i].content);
      if (text.length > 0) {
        user_msgs.unshift(text.length > 160 ? text.slice(0, 156) + "..." : text);
      }
    }
  }
  return user_msgs;
}

export function collect_tools_used(messages: ConversationMessage[]): string[] {
  const tools = new Set<string>();
  for (const msg of messages) {
    for (const name of tool_names_from_blocks(msg.content)) {
      tools.add(name);
    }
  }
  return [...tools];
}

export function collect_key_files(messages: ConversationMessage[]): string[] {
  const all_paths = new Set<string>();
  for (const msg of messages) {
    for (const p of extract_file_paths(msg.content)) {
      all_paths.add(p);
    }
  }
  return [...all_paths];
}

export function collect_pending_work(messages: ConversationMessage[]): string[] {
  const pending: string[] = [];
  const keywords = /\b(todo|next|pending|follow up|remaining|need to|must|should)\b/i;

  for (const msg of messages) {
    const text = text_from_blocks(msg.content);
    if (keywords.test(text)) {
      const sentence = text.split(/[.!?\n]/).find((s) => keywords.test(s));
      if (sentence) {
        pending.push(sentence.trim().slice(0, 200));
      }
    }
  }

  return [...new Set(pending)].slice(0, 5);
}

export function get_first_text_block(messages: ConversationMessage[]): string {
  for (const msg of messages) {
    const text = text_from_blocks(msg.content);
    if (text.length > 0) return text;
  }
  return "";
}

export interface StructuredSummary {
  scope: string;
  tools_used: string[];
  recent_user_requests: string[];
  pending_work: string[];
  key_files: string[];
  timeline: string;
  current_work: string;
}

export function summarize_messages(messages: ConversationMessage[]): StructuredSummary {
  const text_parts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      const s = summarize_block(block);
      if (s) text_parts.push(s);
    }
  }

  return {
    scope: text_parts.join("; ").slice(0, 500),
    tools_used: collect_tools_used(messages),
    recent_user_requests: collect_recent_role_summaries(messages, 3),
    pending_work: collect_pending_work(messages),
    key_files: collect_key_files(messages),
    timeline: text_parts.slice(-5).join(" -> "),
    current_work: get_first_text_block(messages.slice(-3)),
  };
}

// ---------- summary formatting ----------

function format_list(items: string[]): string {
  return items.length > 0 ? items.map((i) => `  - ${i}`).join("\n") : "  - (none)";
}

export function format_compact_summary(summary: StructuredSummary): string {
  const lines = [
    "<summary>",
    `Scope: ${summary.scope || "(conversation)"}`,
    "",
    "Tools used:",
    format_list(summary.tools_used),
    "",
    "Recent user requests:",
    format_list(summary.recent_user_requests),
  ];

  if (summary.pending_work.length > 0) {
    lines.push("", "Pending work:", format_list(summary.pending_work));
  }

  if (summary.key_files.length > 0) {
    lines.push("", "Key files:", format_list(summary.key_files));
  }

  lines.push(
    "",
    "Timeline:",
    `  ${summary.timeline || "(none)"}`,
    "",
    "Current work:",
    `  ${summary.current_work || "(unknown)"}`,
    "</summary>",
  );

  return lines.join("\n");
}

// ---------- summary merging ----------

function extract_existing_compacted_summary(session: Session): string | null {
  if (session.messages.length === 0) return null;

  const first = session.messages[0];
  if (first.role !== MessageRole.System) return null;

  const text = text_from_blocks(first.content);
  if (!text.includes("continued from a previous conversation")) return null;

  // Extract the <summary> tag content
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : null;
}

function merge_compact_summaries(existing: string | null, new_summary: string): string {
  if (!existing) return new_summary;

  const new_text = new_summary.replace(/<\/?summary>/g, "").trim();
  return `<summary>\nPreviously compacted context:\n${existing}\n\nNewly compacted context:\n${new_text}\n</summary>`;
}

// ---------- compact session ----------

export function compact_session(session: Session, config: CompactionConfig): CompactionResult {
  if (!should_compact(session, config)) {
    return {
      summary: "",
      compacted_session: clone_session(session),
      removed_message_count: 0,
    };
  }

  const existing_summary = extract_existing_compacted_summary(session);
  const compacted_prefix_len = existing_summary ? 1 : 0;

  const keep_from = find_compaction_boundary(session.messages, config.preserve_recent_messages);

  const removed_messages = session.messages.slice(compacted_prefix_len, keep_from);
  const preserved_messages = session.messages.slice(keep_from);

  const raw_summary = summarize_messages(removed_messages);
  const new_summary_text = format_compact_summary(raw_summary);

  const merged_summary = merge_compact_summaries(existing_summary, new_summary_text);

  const preamble = text_from_blocks(
    session.messages.slice(0, compacted_prefix_len).flatMap((m) => m.content),
  ).startsWith("This session is being continued")
    ? ""
    : COMPACT_CONTINUATION_PREAMBLE;

  const system_text = preamble + merged_summary + "\n\n" + COMPACT_DIRECT_RESUME_INSTRUCTION;

  const compacted_messages: ConversationMessage[] = [
    {
      role: MessageRole.System,
      content: [{ type: "text", text: system_text }],
    },
    ...preserved_messages,
  ];

  return {
    summary: merged_summary,
    compacted_session: { messages: compacted_messages },
    removed_message_count: removed_messages.length,
  };
}
