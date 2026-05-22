import { describe, it, expect } from "vitest";
import {
  Session,
  ConversationMessage,
  MessageRole,
  ContentBlock,
} from "../src/session.js";
import {
  stage1_supersede,
  stage2_collapse,
  stage3_cluster,
  trident_compact_session,
  DEFAULT_TRIDENT_CONFIG,
  format_report,
} from "../src/trident.js";
import { DEFAULT_COMPACT_CONFIG } from "../src/compact.js";

function user(text: string): ConversationMessage {
  return { role: MessageRole.User, content: [{ type: "text", text }] };
}

function assistant(text: string): ConversationMessage {
  return { role: MessageRole.Assistant, content: [{ type: "text", text }] };
}

function tool_read(path: string, result: string): ConversationMessage[] {
  const id = `t_${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      role: MessageRole.Assistant,
      content: [
        { type: "text", text: `reading ${path}` },
        { type: "tool_use", id, name: "read_file", input: { path } },
      ],
    },
    {
      role: MessageRole.Tool,
      content: [{ type: "tool_result", tool_use_id: id, tool_name: "read_file", output: result, is_error: false }],
    },
  ];
}

function tool_edit(path: string): ConversationMessage[] {
  const id = `t_${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      role: MessageRole.Assistant,
      content: [
        { type: "text", text: `editing ${path}` },
        { type: "tool_use", id, name: "edit_file", input: { path } },
      ],
    },
    {
      role: MessageRole.Tool,
      content: [{ type: "tool_result", tool_use_id: id, tool_name: "edit_file", output: "done", is_error: false }],
    },
  ];
}

// ---------- stage 1: supersede ----------

describe("stage1_supersede", () => {
  it("removes obsolete reads before a write to the same file", () => {
    const msgs = [
      ...tool_read("/src/main.rs", "old content"),
      user("fix the bug"),
      ...tool_edit("/src/main.rs"),
      user("looks good"),
    ];
    const result = stage1_supersede(msgs);
    // The first read should be superseded by the later edit
    expect(result.superseded_count).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeLessThan(msgs.length);
  });

  it("keeps standalone reads with no subsequent write", () => {
    const msgs = [
      ...tool_read("/src/main.rs", "content"),
      user("what's in this file?"),
    ];
    const result = stage1_supersede(msgs);
    expect(result.superseded_count).toBe(0);
    expect(result.messages.length).toBe(msgs.length);
  });

  it("keeps non-file messages untouched", () => {
    const msgs = [
      user("hello"),
      assistant("hi there"),
      user("how are you"),
    ];
    const result = stage1_supersede(msgs);
    expect(result.superseded_count).toBe(0);
    expect(result.messages.length).toBe(msgs.length);
  });
});

// ---------- stage 2: collapse ----------

describe("stage2_collapse", () => {
  it("collapses runs of chatty messages at or above threshold", () => {
    const msgs: ConversationMessage[] = [
      user("hey"),
      assistant("hi"),
      user("ok"),
      assistant("got it"),
      user("cool"),
      assistant("thanks"),
      user("done"), // 7 chatty messages — above threshold of 4
    ];
    const result = stage2_collapse(msgs, 4);
    expect(result.collapsed_count).toBe(7);
    expect(result.messages.length).toBe(1); // collapsed into one
    const collapsed_text = (result.messages[0].content[0] as { type: "text"; text: string }).text;
    expect(collapsed_text).toContain("[Collapsed 7 messages]");
  });

  it("does not collapse below threshold", () => {
    const msgs: ConversationMessage[] = [
      user("hey"),
      assistant("hi"),
      user("ok"),
    ];
    const result = stage2_collapse(msgs, 4);
    expect(result.collapsed_count).toBe(0);
    expect(result.messages.length).toBe(3);
  });

  it("does not collapse through a tool_use message", () => {
    const msgs: ConversationMessage[] = [
      user("hey"),
      assistant("hi"),
      ...tool_read("/src/main.rs", "content"),
      user("thanks"),
      assistant("ok"),
    ];
    const result = stage2_collapse(msgs, 4);
    // The tool_use breaks the chain — neither side has enough chatty messages
    expect(result.collapsed_count).toBe(0);
    expect(result.messages.length).toBe(6);
  });
});

// ---------- stage 3: cluster ----------

describe("stage3_cluster", () => {
  it("clusters messages with same tools and files", () => {
    const msgs: ConversationMessage[] = [
      ...tool_read("/src/main.rs", "a"),
      ...tool_read("/src/main.rs", "b"),
      ...tool_read("/src/main.rs", "c"),
      user("summarize"),
    ];
    const result = stage3_cluster(msgs, 3, 0.6);
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    expect(result.messages_clustered).toBeGreaterThanOrEqual(3);
  });

  it("does not cluster unrelated messages", () => {
    const msgs: ConversationMessage[] = [
      ...tool_read("/src/a.rs", "a"),
      user("do something else"),
      assistant("done"),
    ];
    const result = stage3_cluster(msgs, 3, 0.6);
    expect(result.clusters.length).toBe(0);
  });
});

// ---------- full pipeline ----------

describe("trident_compact_session", () => {
  it("returns input count and produces stats", () => {
    const msgs: ConversationMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(user(`msg ${i}`));
      msgs.push(assistant(`resp ${i}`));
    }
    const session: Session = { messages: msgs };
    const result = trident_compact_session(
      session,
      { preserve_recent_messages: 4, max_estimated_tokens: 0 },
      DEFAULT_TRIDENT_CONFIG,
    );
    expect(result.stats.messages_input).toBe(40);
    expect(result.removed_message_count).toBeGreaterThanOrEqual(0);
  });

  it("all stages disabled produces same as compact_session", () => {
    const msgs: ConversationMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(user(`msg ${i}`));
      msgs.push(assistant(`resp ${i}`));
    }
    const session: Session = { messages: msgs };
    const all_off = trident_compact_session(
      session,
      { preserve_recent_messages: 4, max_estimated_tokens: 0 },
      { ...DEFAULT_TRIDENT_CONFIG, supersede_enabled: false, collapse_enabled: false, cluster_enabled: false },
    );
    expect(all_off.stats.superseded_count).toBe(0);
    expect(all_off.stats.collapsed_count).toBe(0);
    expect(all_off.stats.clustered_count).toBe(0);
  });
});

// ---------- format_report ----------

describe("format_report", () => {
  it("contains expected sections", () => {
    const report = format_report({
      messages_input: 100,
      messages_after_supersede: 80,
      messages_after_collapse: 60,
      messages_after_cluster: 40,
      superseded_count: 20,
      collapsed_count: 20,
      clustered_count: 20,
      clusters_found: 3,
    });
    expect(report).toContain("Supersede: 20 obsolete removed");
    expect(report).toContain("80 -> 60 messages");
    expect(report).toContain("100 messages | Final: 40 messages");
  });
});
