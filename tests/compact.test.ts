import { describe, it, expect } from "vitest";
import {
  Session,
  ConversationMessage,
  MessageRole,
  ContentBlock,
} from "../src/session.js";
import {
  estimate_tokens,
  find_compaction_boundary,
  compact_session,
  summarize_messages,
  format_compact_summary,
  collect_key_files,
  collect_pending_work,
  DEFAULT_COMPACT_CONFIG,
} from "../src/compact.js";

function user(text: string): ConversationMessage {
  return { role: MessageRole.User, content: [{ type: "text", text }] };
}

function assistant(text: string): ConversationMessage {
  return { role: MessageRole.Assistant, content: [{ type: "text", text }] };
}

function assistant_with_tools(
  text: string,
  tool_name: string,
  tool_input: unknown,
  result: string,
): ConversationMessage[] {
  const tool_id = `tool_${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      role: MessageRole.Assistant,
      content: [
        { type: "text", text },
        { type: "tool_use", id: tool_id, name: tool_name, input: tool_input },
      ],
    },
    {
      role: MessageRole.Tool,
      content: [{ type: "tool_result", tool_use_id: tool_id, tool_name, output: result, is_error: false }],
    },
  ];
}

function thinking(thinking_text: string): ContentBlock {
  return { type: "thinking", thinking: thinking_text };
}

// ---------- token estimation ----------

describe("estimate_tokens", () => {
  it("estimates tokens from text blocks", () => {
    const tokens = estimate_tokens([{ type: "text", text: "hello world" }]);
    expect(tokens).toBe(Math.ceil(11 / 4) + 1); // 4
  });

  it("includes thinking blocks", () => {
    const tokens = estimate_tokens([
      { type: "thinking", thinking: "some reasoning" },
      { type: "text", text: "hello" },
    ]);
    expect(tokens).toBe(Math.ceil(14 / 4) + 1 + Math.ceil(5 / 4) + 1);
  });

  it("includes thinking signature", () => {
    const tokens = estimate_tokens([
      { type: "thinking", thinking: "reasoning", signature: "sig123" },
    ]);
    expect(tokens).toBe(Math.ceil(9 / 4) + 1 + Math.ceil(6 / 4) + 1);
  });

  it("estimates tool_use from serialized input", () => {
    const tokens = estimate_tokens([
      { type: "tool_use", id: "1", name: "read_file", input: { path: "/src/main.rs" } },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tool_result from output", () => {
    const tokens = estimate_tokens([
      { type: "tool_result", tool_use_id: "1", tool_name: "read_file", output: "file contents here", is_error: false },
    ]);
    expect(tokens).toBe(Math.ceil(17 / 4) + 1);
  });
});

// ---------- boundary repair ----------

describe("find_compaction_boundary", () => {
  it("returns messages.length when preserve_recent is 0", () => {
    const msgs = [user("a"), assistant("b"), user("c")];
    expect(find_compaction_boundary(msgs, 0)).toBe(3);
  });

  it("preserves last N messages", () => {
    const msgs = [user("1"), user("2"), user("3"), user("4")];
    expect(find_compaction_boundary(msgs, 2)).toBe(2);
  });

  it("walks back to avoid orphaning a tool_result", () => {
    // messages[0] = assistant with tool_use
    // messages[1] = tool result
    // messages[2] = user
    // messages[3] = assistant
    // preserve_recent = 2, so keep_from = 2, which is user — safe
    const tool_id = "t1";
    const msgs: ConversationMessage[] = [
      {
        role: MessageRole.Assistant,
        content: [
          { type: "text", text: "reading file" },
          { type: "tool_use", id: tool_id, name: "read_file", input: { path: "/x" } },
        ],
      },
      {
        role: MessageRole.Tool,
        content: [{ type: "tool_result", tool_use_id: tool_id, tool_name: "read_file", output: "contents", is_error: false }],
      },
      user("thanks"),
      assistant("done"),
    ];
    // keep_from = 4 - 2 = 2 → messages[2] is user → not a tool_result → boundary stays at 2
    expect(find_compaction_boundary(msgs, 2)).toBe(2);
  });

  it("walks back when first preserved is an orphaned tool_result", () => {
    const tool_id = "t1";
    const msgs: ConversationMessage[] = [
      user("hi"),
      {
        role: MessageRole.Assistant,
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: tool_id, name: "read_file", input: { path: "/x" } },
        ],
      },
      {
        role: MessageRole.Tool,
        content: [{ type: "tool_result", tool_use_id: tool_id, tool_name: "read_file", output: "contents", is_error: false }],
      },
      user("ok"),
      assistant("done"),
    ];
    // preserve_recent = 2 → keep_from = 3 → messages[3] is user → safe
    expect(find_compaction_boundary(msgs, 2)).toBe(3);
  });
});

// ---------- compact_session ----------

describe("compact_session", () => {
  it("returns original session when under budget", () => {
    const session: Session = { messages: [user("hello"), assistant("hi")] };
    const result = compact_session(session, {
      preserve_recent_messages: 1,
      max_estimated_tokens: 1_000_000,
    });
    expect(result.removed_message_count).toBe(0);
    expect(result.compacted_session.messages.length).toBe(2);
  });

  it("compacts larger sessions", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(user(`message ${i}`));
      messages.push(assistant(`response ${i}`));
    }
    const session: Session = { messages };
    const result = compact_session(session, {
      preserve_recent_messages: 4,
      max_estimated_tokens: 0, // force compaction
    });
    expect(result.removed_message_count).toBeGreaterThan(0);
    expect(result.compacted_session.messages.length).toBeLessThan(60);
    // First message should be the system summary
    expect(result.compacted_session.messages[0].role).toBe(MessageRole.System);
  });

  it("merges summaries on cascaded compaction", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(user(`msg ${i}`));
      messages.push(assistant(`resp ${i}`));
    }
    const session: Session = { messages };

    const first = compact_session(session, {
      preserve_recent_messages: 4,
      max_estimated_tokens: 0,
    });
    expect(first.compacted_session.messages[0].content[0].type).toBe("text");

    const first_text = (first.compacted_session.messages[0].content[0] as { type: "text"; text: string }).text;
    expect(first_text).toContain("continued from a previous conversation");
  });
});

// ---------- summarization helpers ----------

describe("collect_key_files", () => {
  it("extracts file paths from tool_use", () => {
    const msgs: ConversationMessage[] = [
      {
        role: MessageRole.Assistant,
        content: [
          { type: "text", text: "let me read that" },
          { type: "tool_use", id: "1", name: "read_file", input: { path: "/src/main.rs" } },
        ],
      },
    ];
    const files = collect_key_files(msgs);
    expect(files).toContain("/src/main.rs");
  });

  it("extracts file paths from thinking blocks", () => {
    const msgs: ConversationMessage[] = [
      {
        role: MessageRole.Assistant,
        content: [
          { type: "thinking", thinking: "I need to check src/main.ts for the bug" },
        ],
      },
    ];
    const files = collect_key_files(msgs);
    expect(files).toContain("src/main.ts");
  });
});

describe("collect_pending_work", () => {
  it("finds pending work from user messages", () => {
    const msgs = [
      user("we still need to add error handling"),
      assistant("ok"),
    ];
    const pending = collect_pending_work(msgs);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]).toContain("need to");
  });

  it("returns empty for no pending work", () => {
    const msgs = [user("thanks"), assistant("done")];
    const pending = collect_pending_work(msgs);
    expect(pending).toHaveLength(0);
  });
});

// ---------- format_compact_summary ----------

describe("format_compact_summary", () => {
  it("includes all sections", () => {
    const summary = summarize_messages([
      user("read the file"),
      assistant("here it is"),
    ]);
    const formatted = format_compact_summary(summary);
    expect(formatted).toContain("<summary>");
    expect(formatted).toContain("</summary>");
    expect(formatted).toContain("Scope:");
    expect(formatted).toContain("Tools used:");
    expect(formatted).toContain("Recent user requests:");
  });
});
