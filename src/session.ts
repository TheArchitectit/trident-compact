export enum MessageRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; tool_name: string; output: string; is_error: boolean };

export interface ConversationMessage {
  role: MessageRole;
  content: ContentBlock[];
}

export interface Session {
  messages: ConversationMessage[];
}

export function clone_session(session: Session): Session {
  return {
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) => ({ ...b })),
    })),
  };
}

export function save_session(session: Session, path: string): void {
  const fs = require("fs");
  fs.writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
}

export function load_session(path: string): Session {
  const fs = require("fs");
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

export function text_from_blocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function has_tool_use(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => b.type === "tool_use");
}

export function tool_names_from_blocks(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map((b) => b.name);
}

export function extract_file_paths(blocks: ContentBlock[]): string[] {
  const paths: string[] = [];
  const interesting = /\.(rs|ts|tsx|js|jsx|json|md|toml|yaml|yml|py|go|c|cpp|h|hpp)$/;

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      for (const key of ["path", "file_path", "filePath"]) {
        if (typeof input[key] === "string") {
          paths.push(input[key] as string);
        }
      }
    }
    if (block.type === "text" || block.type === "thinking") {
      const text = block.type === "text" ? block.text : block.thinking;
      const matches = text.match(/[\w/.-]+(?:[\w/.-]+)+(?:\.[a-z]{1,5})/g) ?? [];
      for (const m of matches) {
        if (interesting.test(m)) {
          paths.push(m);
        }
      }
    }
  }

  return [...new Set(paths)];
}
