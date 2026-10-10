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

### Atomic transaction ownership

Atomic writes acquire exclusive `<target>.atomic-lock` files for every write target
and content-verification dependency, in sorted canonical path order. Locks cover
commit and rollback; a competing writer fails explicitly instead of risking a
successful write being undone. Expected-content checks still reject stale reads.
Callers may reread current state and explicitly retry after an ownership conflict.

A process crash can leave a lock behind. Recovery must establish that no writer
is active before manually removing only the identified stale lock. Locks are not
automatically expired or stolen. Use canonical paths; direct filesystem writes
and symlink aliases do not participate in this cooperative transaction protocol.
