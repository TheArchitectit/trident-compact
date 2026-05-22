# trident-compact

Three-stage session compaction pipeline for LLM agent conversations. Ports the compaction architecture from [ClawCode](https://github.com/TheArchitectit/claw-code) into a standalone TypeScript/Node library.

## Why

LLM agent sessions accumulate messages fast — tool calls, file reads, confirmations, thinking blocks. When you hit the context window limit, you lose the whole conversation. `trident-compact` compresses sessions intelligently while preserving the information that matters.

## Pipeline

```
Input messages
    │
    ├─ Stage 1: Supersede ─── Remove obsolete file reads/writes
    │                          (last write to a file supersedes all earlier reads)
    │
    ├─ Stage 2: Collapse ──── Merge consecutive low-value messages
    │                          (ACKs, confirmations, short exchanges)
    │
    ├─ Stage 3: Cluster ───── Group similar messages by tool/file overlap
    │                          (Jaccard similarity on tool names + file paths)
    │
    └─ Compact ────────────── Summarize remaining messages into a
                             continuation prompt with structured context
```

## Install

```bash
npm install trident-compact
```

## Usage

```typescript
import {
  trident_compact_session,
  type Session,
  type CompactionConfig,
  type TridentConfig,
} from "trident-compact";

const session: Session = {
  messages: [
    // ... your conversation messages
  ],
};

// Force compaction with max_estimated_tokens: 0
const result = trident_compact_session(
  session,
  { preserve_recent_messages: 4, max_estimated_tokens: 0 },
  {
    supersede_enabled: true,
    collapse_enabled: true,
    cluster_enabled: true,
    collapse_threshold: 4,
    cluster_min_size: 3,
    cluster_similarity_threshold: 0.6,
  },
);

console.log(result.compacted_session); // Session with summary + preserved recent messages
console.log(result.stats);             // Per-stage counts and compression ratio
```

## API

### Core

- `trident_compact_session(session, compact_config, trident_config?)` — Full pipeline. Returns `CompactionResult & { stats: TridentStats }`.
- `compact_session(session, config)` — Summary-based compaction only (no Trident stages).
- `find_compaction_boundary(messages, preserve_recent)` — Find the safe split point that doesn't orphan tool_use/tool_result pairs.

### Stages

- `stage1_supersede(messages)` — Remove obsolete file operations.
- `stage2_collapse(messages, threshold)` — Merge chatty exchanges.
- `stage3_cluster(messages, min_size, threshold)` — Group similar messages.

### Token Estimation

- `estimate_tokens(blocks)` — Characters / 4 + 1 per block.
- `estimate_session_tokens(messages)` — Total tokens for a message array.

### Session Helpers

- `clone_session(session)` — Deep clone.
- `text_from_blocks(blocks)`, `has_tool_use(blocks)`, `tool_names_from_blocks(blocks)`, `extract_file_paths(blocks)`.

## Content Block Types

The library handles all Anthropic API content block types:

| Block | Compact behavior |
|-------|-----------------|
| `text` | Summarized, truncated at 160 chars in scope |
| `thinking` | Included in token estimation, `"thinking (N chars)"` in summary |
| `tool_use` | Tracked for supersede (by file path) and clustering (by tool name) |
| `tool_result` | Prevents boundary splits; included in token estimation |

## Known Design Decisions

- **Supersede only tracks file operations** — non-file tool calls (API calls, calculations) are never superseded. This is conservative by design.
- **Clustering requires at least one non-empty dimension** — two pure-text messages with no tool calls or file references won't cluster together, even if their text is similar. Prevents false merges on empty sets.
- **Thinking blocks are not chatty** — even short thinking blocks are treated as substantive content, preventing collapse of important reasoning chains.

## License

BSD 3-Clause. See [LICENSE](./LICENSE).
