# RepoBrain Programmatic API

RepoBrain provides a formal library entry at `repobrain` (built from `src/index.ts`).

## Install and Import

```ts
import {
  loadConfig,
  loadAllMemories,
  loadStoredMemoryRecords,
  loadAllPreferences,
  saveMemory,
  initBrain,
  buildInjection,
  buildSkillShortlist,
  buildTaskRoutingBundle,
  extractMemories,
  parseRuleFileToMemories,
  reviewCandidateMemory,
  reviewCandidateMemories,
} from "repobrain";
```

## Entry Points

- Library entry: `repobrain` -> `dist/index.js`
- CLI entry: `brain` bin -> `dist/cli.js`
- Optional direct CLI module import: `repobrain/cli`

## API Surface

### Core Read

- `loadConfig(projectRoot: string): Promise<BrainConfig>`
- `loadAllMemories(projectRoot: string): Promise<Memory[]>`
- `loadStoredMemoryRecords(projectRoot: string): Promise<StoredMemoryRecord[]>`
- `loadAllPreferences(projectRoot: string): Promise<Preference[]>`

### Core Write

- `saveMemory(memory: Memory, projectRoot: string): Promise<string>`
- `initBrain(projectRoot: string): Promise<void>`

### Injection

- `buildInjection(projectRoot: string, config: BrainConfig, options?: BuildInjectionOptions): Promise<string>`

### Routing

- `buildSkillShortlist(projectRoot: string, options: SuggestSkillsOptions): Promise<SkillSuggestionResult>`
- `buildTaskRoutingBundle(projectRoot: string, config: BrainConfig, options: BuildTaskRoutingBundleOptions): Promise<TaskRoutingBundle>`

### Extraction

- `extractMemories(conversationText: string, config: BrainConfig, projectRoot?: string): Promise<Memory[]>`
- `parseRuleFileToMemories(content: string, filePath: string, options?: ImportOptions): Memory[]`

Example:

```ts
const imported = parseRuleFileToMemories(ruleMarkdown, "AGENTS.md", {
  defaultType: "convention",
  defaultImportance: "medium",
});
```

Use `parseRuleFileToMemories` when a repo already has durable guidance in Markdown rule files and you want to convert those sections into candidate memories before saving or reviewing them.

### Review

- `reviewCandidateMemory(memory: Memory, existingRecords: StoredMemoryRecord[], externalReviewInput?: unknown): CandidateMemoryReviewResult`
- `reviewCandidateMemories(memories: Memory[], existingRecords: StoredMemoryRecord[], options?: MemoryReviewer | ReviewCandidateMemoriesOptions): ReviewedMemoryCandidate[]`

### Types

All exports from `src/types.ts` are re-exported at the package root:

```ts
import type { BrainConfig, Memory, Preference, StoredMemoryRecord } from "repobrain";
```

## Compatibility Notes

- Programmatic API does not require `commander` runtime usage and does not read `process.stdin`.
- CLI behavior remains unchanged and continues to use the `brain` executable.

### Non-recording retrieval

`buildInjection`, `buildTaskRoutingBundle`, and `buildConversationStart` accept
`recordActivity: false` for reviewer/audit retrieval without changing memory usage,
activity timestamps, or conversation refresh history. Default calls still record
usage and activity. Non-recording conversation-start evaluates existing history;
it does not advance that history. Selection and provenance checks still apply.

The MCP tools `brain_get_context`, `brain_route`, and `brain_conversation_start`
accept the same boolean argument (default `true`). Their tool-level read-only
and idempotent hints are false because default calls can write metadata; choosing
`recordActivity: false` avoids those writes but does not turn an annotation into
a permission boundary. CLI behavior remains recording by default.
