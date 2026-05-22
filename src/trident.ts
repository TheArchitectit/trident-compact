import {
  Session,
  ConversationMessage,
  MessageRole,
  ContentBlock,
  clone_session,
  text_from_blocks,
  has_tool_use,
  tool_names_from_blocks,
  extract_file_paths,
} from "./session.js";
import { compact_session, CompactionConfig, CompactionResult } from "./compact.js";

// ---------- config ----------

export interface TridentConfig {
  supersede_enabled: boolean;
  collapse_enabled: boolean;
  cluster_enabled: boolean;
  collapse_threshold: number;
  cluster_min_size: number;
  cluster_similarity_threshold: number;
  max_file_operations: number;
}

export const DEFAULT_TRIDENT_CONFIG: TridentConfig = {
  supersede_enabled: true,
  collapse_enabled: true,
  cluster_enabled: true,
  collapse_threshold: 4,
  cluster_min_size: 3,
  cluster_similarity_threshold: 0.6,
  max_file_operations: 100,
};

// ---------- stats ----------

export interface TridentStats {
  messages_input: number;
  messages_after_supersede: number;
  messages_after_collapse: number;
  messages_after_cluster: number;
  superseded_count: number;
  collapsed_count: number;
  clustered_count: number;
  clusters_found: number;
}

export function format_report(stats: TridentStats): string {
  const ratio =
    stats.messages_input > 0
      ? (stats.messages_input / Math.max(stats.messages_after_cluster, 1)).toFixed(1)
      : "0";
  return [
    `Supersede: ${stats.superseded_count} obsolete removed`,
    `Collapse:  ${stats.messages_after_supersede} -> ${stats.messages_after_collapse} messages`,
    `Cluster:   ${stats.messages_after_collapse} -> ${stats.messages_after_cluster} messages`,
    `Original:  ${stats.messages_input} messages | Final: ${stats.messages_after_cluster} messages (${ratio}x compression)`,
  ].join("\n");
}

// ---------- helpers ----------

const READ_TOOLS = new Set(["read_file", "glob", "grep", "search", "find", "list_files", "read"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "create_file", "write", "edit", "replace"]);

function is_read_tool(name: string): boolean {
  return READ_TOOLS.has(name);
}

function is_write_tool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

function first_tool_use_name(msg: ConversationMessage): string | null {
  const block = msg.content.find((b) => b.type === "tool_use");
  if (block && block.type === "tool_use") return block.name;
  return null;
}

function first_tool_result_name(msg: ConversationMessage): string | null {
  const block = msg.content.find((b) => b.type === "tool_result");
  if (block && block.type === "tool_result") return block.tool_name;
  return null;
}

function tool_name_for(msg: ConversationMessage): string | null {
  return first_tool_use_name(msg) ?? first_tool_result_name(msg);
}

function extract_path_from_tool(msg: ConversationMessage): string | null {
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;

  const input = block.input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return null;
}

function text_length(msg: ConversationMessage): number {
  return text_from_blocks(msg.content).length;
}

function is_chatty_message(msg: ConversationMessage): boolean {
  // Messages with tool calls are never chatty
  if (has_tool_use(msg.content)) return false;

  let total_chars = 0;
  let block_count = 0;

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        total_chars += block.text.length;
        break;
      case "thinking":
        // Thinking blocks can be long but are internal — treat them
        // as substantive content so we don't collapse important reasoning.
        total_chars += block.thinking.length;
        break;
      case "tool_result":
        return false;
      default:
        break;
    }
    block_count++;
  }

  return block_count > 0 && total_chars < 200;
}

// ---------- stage 1: supersede ----------

interface SupersedeResult {
  messages: ConversationMessage[];
  superseded_count: number;
}

export function stage1_supersede(messages: ConversationMessage[]): SupersedeResult {
  // Build a map: file_path -> last write index
  const last_write = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const tool_name = tool_name_for(messages[i]);
    if (tool_name && is_write_tool(tool_name)) {
      const path = extract_path_from_tool(messages[i]);
      if (path) last_write.set(path, i);
    }
  }

  // Collect indices of obsolete messages
  const obsolete = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const tool_name = tool_name_for(messages[i]);
    if (!tool_name) continue;

    const path = extract_path_from_tool(messages[i]);
    if (!path) continue;

    const lw = last_write.get(path);
    if (lw === undefined) continue;

    if (is_read_tool(tool_name) && i < lw) {
      obsolete.add(i);
    }

    if (is_write_tool(tool_name) && i < lw) {
      obsolete.add(i);
    }
  }

  const kept = messages.filter((_, i) => !obsolete.has(i));
  return { messages: kept, superseded_count: obsolete.size };
}

// ---------- stage 2: collapse ----------

interface CollapseResult {
  messages: ConversationMessage[];
  collapsed_count: number;
  chains: number[];
}

export function stage2_collapse(
  messages: ConversationMessage[],
  threshold: number,
): CollapseResult {
  const result: ConversationMessage[] = [];
  const chains: number[] = [];
  let chatty_run: ConversationMessage[] = [];
  let collapsed_count = 0;

  function flush_chatty_run() {
    if (chatty_run.length >= threshold) {
      const topics = [
        ...new Set(
          chatty_run.map((m) => {
            const text = text_from_blocks(m.content);
            return text.length > 80 ? text.slice(0, 76) + "..." : text;
          }),
        ),
      ].slice(0, 5);

      const user_count = chatty_run.filter((m) => m.role === MessageRole.User).length;
      const assistant_count = chatty_run.filter((m) => m.role === MessageRole.Assistant).length;

      result.push({
        role: MessageRole.System,
        content: [
          {
            type: "text",
            text:
              `[Collapsed ${chatty_run.length} messages] ` +
              `(${user_count} user, ${assistant_count} assistant).\n` +
              `Topics:\n${topics.map((t) => `  - "${t}"`).join("\n")}`,
          },
        ],
      });
      chains.push(chatty_run.length);
      collapsed_count += chatty_run.length;
    } else {
      result.push(...chatty_run);
    }
    chatty_run = [];
  }

  for (const msg of messages) {
    if (is_chatty_message(msg)) {
      chatty_run.push(msg);
    } else {
      flush_chatty_run();
      result.push(msg);
    }
  }
  flush_chatty_run();

  return { messages: result, collapsed_count, chains };
}

// ---------- stage 3: cluster ----------

interface Fingerprint {
  tool_names: Set<string>;
  file_paths: Set<string>;
  role: MessageRole;
  text_length: number;
}

function fingerprint(msg: ConversationMessage): Fingerprint {
  return {
    tool_names: new Set(tool_names_from_blocks(msg.content)),
    file_paths: new Set(extract_file_paths(msg.content)),
    role: msg.role,
    text_length: text_length(msg),
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function similarity(a: Fingerprint, b: Fingerprint): number {
  const tool_sim = jaccard(a.tool_names, b.tool_names);
  const file_sim = jaccard(a.file_paths, b.file_paths);

  // Guard: if both dimensions are empty, don't boost on length alone
  if (a.tool_names.size === 0 && b.tool_names.size === 0 && a.file_paths.size === 0 && b.file_paths.size === 0) {
    return 0;
  }

  const max_len = Math.max(a.text_length, b.text_length, 1);
  const min_len = Math.min(a.text_length, b.text_length);
  const length_sim = min_len / max_len;

  return 0.4 * tool_sim + 0.4 * file_sim + 0.2 * length_sim;
}

interface Cluster {
  centroid_idx: number;
  members: number[];
}

interface ClusterResult {
  messages: ConversationMessage[];
  clusters: Cluster[];
  messages_clustered: number;
}

export function stage3_cluster(
  messages: ConversationMessage[],
  min_size: number,
  threshold: number,
): ClusterResult {
  const fingerprints = messages.map(fingerprint);
  const assigned = new Set<number>();
  const clusters: Cluster[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (assigned.has(i)) continue;

    const centroid = fingerprints[i];
    const members: number[] = [i];

    for (let j = i + 1; j < messages.length; j++) {
      if (assigned.has(j)) continue;
      if (similarity(centroid, fingerprints[j]) >= threshold) {
        members.push(j);
      }
    }

    if (members.length >= min_size) {
      for (const idx of members) assigned.add(idx);
      clusters.push({ centroid_idx: i, members });
    }
  }

  // Build output: replace clusters with summaries, keep unclustered messages
  const cluster_set = new Set<number>();
  for (const c of clusters) {
    for (const idx of c.members) cluster_set.add(idx);
  }

  const result: ConversationMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const cluster = clusters.find((c) => c.members.includes(i));
    if (cluster) {
      const tool_names = [...new Set(cluster.members.flatMap((idx) => [...tool_names_from_blocks(messages[idx].content)]))];
      const file_paths = [...new Set(cluster.members.flatMap((idx) => extract_file_paths(messages[idx].content).map((p) => p.split("/").pop() ?? p)))];

      const lines = [`[Clustered ${cluster.members.length} messages]`];
      if (tool_names.length > 0) lines.push(`Tools: ${tool_names.join(", ")}`);
      if (file_paths.length > 0) lines.push(`Files: ${file_paths.join(", ")}`);

      result.push({
        role: MessageRole.System,
        content: [{ type: "text", text: lines.join("\n") }],
      });

      i = Math.max(...cluster.members) + 1;
    } else {
      result.push(messages[i]);
      i++;
    }
  }

  return {
    messages: result,
    clusters,
    messages_clustered: cluster_set.size,
  };
}

// ---------- orchestration ----------

export function trident_compact_session(
  session: Session,
  compaction_config: CompactionConfig,
  trident_config: TridentConfig = DEFAULT_TRIDENT_CONFIG,
): CompactionResult & { stats: TridentStats } {
  const input_count = session.messages.length;

  let messages = session.messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => ({ ...b })) as ContentBlock[],
  }));

  // Stage 1: Supersede
  let superseded_count = 0;
  if (trident_config.supersede_enabled) {
    const result = stage1_supersede(messages);
    messages = result.messages;
    superseded_count = result.superseded_count;
  }
  const after_supersede = messages.length;

  // Stage 2: Collapse
  let collapsed_count = 0;
  if (trident_config.collapse_enabled) {
    const result = stage2_collapse(messages, trident_config.collapse_threshold);
    messages = result.messages;
    collapsed_count = result.collapsed_count;
  }
  const after_collapse = messages.length;

  // Stage 3: Cluster
  let clustered_count = 0;
  let clusters_found = 0;
  if (trident_config.cluster_enabled) {
    const result = stage3_cluster(
      messages,
      trident_config.cluster_min_size,
      trident_config.cluster_similarity_threshold,
    );
    messages = result.messages;
    clustered_count = result.messages_clustered;
    clusters_found = result.clusters.length;
  }
  const after_cluster = messages.length;

  // Feed into standard compaction
  const trident_session: Session = { messages };
  const compact_result = compact_session(trident_session, compaction_config);

  return {
    ...compact_result,
    stats: {
      messages_input: input_count,
      messages_after_supersede: after_supersede,
      messages_after_collapse: after_collapse,
      messages_after_cluster: after_cluster,
      superseded_count,
      collapsed_count,
      clustered_count,
      clusters_found,
    },
  };
}
