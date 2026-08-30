import { Command } from "commander";
import path from "node:path";
import { stdout as output } from "node:process";
import { getBrainDir, loadConfig } from "../config.js";
import { buildMemoryAudit, renderMemoryAuditResult } from "../audit-memory.js";
import {
  buildMemorySchemaReport,
  normalizeMemorySchemas,
  renderMemoryNormalizeReport,
  renderMemorySchemaReport,
} from "../memory-schema.js";
import { detectFailures } from "../failure-detector.js";
import { clearPendingReinforcementEvents, loadPendingReinforcementState } from "../reinforce-pending.js";
import { reinforceMemories } from "../reinforce.js";
import {
  initBrain,
  loadStoredMemoryRecords,
  loadStoredPreferenceRecords,
  persistSourceBytes,
  supersedeMemoryPair,
  updateIndex,
} from "../store.js";
import {
  loadTimelineContext,
  renderExplainMemory,
  renderExplainPreference,
  renderMemoryTimeline,
  renderPreferenceTimeline,
  resolveMemoryRecordById,
  resolvePreferenceRecordById,
} from "../timeline-explain.js";
import type { Memory, Preference } from "../types.js";
import { t } from "../i18n.js";
import { BrainUserError } from "../errors.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("supersede <newMemoryFile> <oldMemoryFile>")
    .description("Link a newer memory to an older one and mark the older memory as stale.")
    .option("--yes", "Overwrite an existing supersede relationship without prompting.")
    .action(async (newMemoryFile: string, oldMemoryFile: string, options: { yes?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const { language } = await loadConfig(projectRoot);
      const records = await loadStoredMemoryRecords(projectRoot);
      const newRecord = helpers.resolveStoredMemoryByFile(records, newMemoryFile);
      const oldRecord = helpers.resolveStoredMemoryByFile(records, oldMemoryFile);

      if (newRecord.filePath === oldRecord.filePath) {
        throw new Error("Choose two different memory files for supersede.");
      }

      const newRelativePath = helpers.toBrainRelativePath(newRecord.relativePath);
      const oldRelativePath = helpers.toBrainRelativePath(oldRecord.relativePath);
      const nextVersion = (oldRecord.memory.version ?? 1) + 1;
      const relationshipState = helpers.describeSupersedeState(newRecord, oldRecord, newRelativePath, oldRelativePath);

      if (relationshipState.alreadyLinked) {
        output.write(
          `${t("memory.supersede_already_exists", language, {
            newPath: newRelativePath,
            oldPath: oldRelativePath,
            version: String(newRecord.memory.version ?? nextVersion),
          })}\n`,
        );
        return;
      }

      if (relationshipState.hasExistingRelationship) {
        output.write(`${t("memory.supersede_existing_relationship", language)}\n`);
        for (const line of relationshipState.details) {
          output.write(`  ${line}\n`);
        }

        if (!options.yes) {
          const confirmed = await helpers.confirmSupersedeOverwrite();
          if (!confirmed) {
            output.write("[brain] supersede cancelled.\n");
            return;
          }
        }
      }

      const result = await supersedeMemoryPair(newRecord, oldRecord);
      await updateIndex(projectRoot);
      output.write(
        `${t("memory.supersede_linked", language, {
          newPath: newRelativePath,
          oldPath: oldRelativePath,
          version: String(result.newVersion),
        })}\n`,
      );
    });

  program;

  program
    .command("lineage [memoryFile]")
    .description("Render memory lineage trees from the current .brain store.")
    .action(async (memoryFile: string | undefined) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const records = await loadStoredMemoryRecords(projectRoot);
      const rendered = helpers.renderMemoryLineage(records, memoryFile);
      output.write(`${rendered}\n`);
    });

  program;

  program
    .command("timeline")
    .description("Show temporal evolution: memories (default) or preferences, optionally focused on one file/id.")
    .argument("[file-or-id]", "Optional basename, path fragment, or `.brain/...` relative path.")
    .option("--preferences", "List preference history instead of memory rows when no focus is given.")
    .action(async (fileOrId: string | undefined, options: { preferences?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const { memories, preferences } = await loadTimelineContext(projectRoot);
      const id = fileOrId?.trim();
      if (!id) {
        const text = options.preferences
          ? renderPreferenceTimeline(preferences, null)
          : renderMemoryTimeline(memories, null);
        output.write(`${text}\n`);
        return;
      }
      const mem = resolveMemoryRecordById(projectRoot, id, memories);
      if (mem) {
        output.write(`${renderMemoryTimeline(memories, mem)}\n`);
        return;
      }
      const pref = resolvePreferenceRecordById(projectRoot, id, preferences);
      if (pref) {
        output.write(`${renderPreferenceTimeline(preferences, pref)}\n`);
        return;
      }
      throw new BrainUserError(`No memory or preference matched "${id}".`);
    });

  program;

  program
    .command("explain-memory")
    .description("Print temporal fields, lineage, and inject/routing eligibility for one memory.")
    .argument("<id>", "Memory file basename, path fragment, or `.brain/...` path.")
    .action(async (id: string) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const records = await loadStoredMemoryRecords(projectRoot);
      const record = resolveMemoryRecordById(projectRoot, id, records);
      if (!record) {
        throw new BrainUserError(`No memory matched "${id}".`);
      }
      output.write(`${renderExplainMemory(record, new Date())}\n`);
    });

  program;

  program
    .command("explain-preference")
    .description("Print temporal fields and routing eligibility for one preference file.")
    .argument("<id>", "Preference file basename, path fragment, or `.brain/...` path.")
    .action(async (id: string) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const records = await loadStoredPreferenceRecords(projectRoot);
      const record = resolvePreferenceRecordById(projectRoot, id, records);
      if (!record) {
        throw new BrainUserError(`No preference matched "${id}".`);
      }
      output.write(`${renderExplainPreference(record, new Date())}\n`);
    });

  program;

  program
    .command("audit-memory")
    .description("Audit stored memories for stale, conflict, low-signal, and overscoped entries.")
    .option("--json", "Print the audit result as JSON.")
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const result = await buildMemoryAudit(projectRoot);
      output.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMemoryAuditResult(result)}\n`);
    });

  program;

  program
    .command("lint-memory")
    .description("Lint memory frontmatter schema health without modifying files.")
    .option("--json", "Print the schema report as JSON.")
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const result = await buildMemorySchemaReport(projectRoot);
      output.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMemorySchemaReport(result)}\n`);
    });

  program;

  program
    .command("normalize-memory")
    .description("Normalize compatible memory frontmatter in place and report any manual-fix schema issues.")
    .option("--json", "Print the normalization result as JSON.")
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const result = await normalizeMemorySchemas(projectRoot);
      await updateIndex(projectRoot);
      output.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMemoryNormalizeReport(result)}\n`);
    });

  program;

  program
    .command("reinforce")
    .description(
      "Apply queued reinforcement suggestions, or analyze stdin for repeated failures and then reinforce memories.",
    )
    .option("--source <source>", "Input source label for analysis context", "session")
    .option("--pending", "Apply pending reinforcement suggestions saved by the session-end workflow.")
    .option("--yes", "Skip confirmation and apply reinforcement immediately.")
    .action(async (options: { source: "session" | "git-commit"; pending?: boolean; yes?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);
      const { language } = await loadConfig(projectRoot);

      const records = await loadStoredMemoryRecords(projectRoot);
      const pendingState = await loadPendingReinforcementState(projectRoot);
      const stdinPayload = options.pending ? undefined : await helpers.readStdinPayload();
      const stdinText = stdinPayload?.text ?? "";
      if (!options.pending && !stdinText.trim()) {
        if (pendingState.events.length > 0) {
          throw new Error(
            'Provide stdin, or run "brain reinforce --pending" to apply queued reinforcement suggestions.',
          );
        }
        throw new Error("Provide a session summary or commit message over stdin.");
      }

      let events = options.pending
        ? pendingState.events
        : detectFailures(
            options.source === "git-commit" ? `Source: git-commit\n\n${stdinText}` : stdinText,
            records.map((entry) => ({
              ...entry.memory,
              filePath: entry.filePath,
              relativePath: entry.relativePath,
            })),
          );
      if (!options.pending && stdinPayload && events.length > 0) {
        const sourceEpisode = await persistSourceBytes(projectRoot, stdinPayload.bytes);
        events = events.map((event) => ({ ...event, source_episode: sourceEpisode }));
      }

      const routingReminders = pendingState.routing_feedback_reminders ?? [];
      if (routingReminders.length > 0) {
        output.write(`Routing feedback reminders (${routingReminders.length}):\n`);
        for (const [index, reminder] of routingReminders.entries()) {
          output.write(`  ${index + 1}. [${reminder.event_type}] ${reminder.summary}\n`);
        }
        output.write('(Review locally; clear with "brain routing-feedback --ack-reminders" after triage.)\n\n');
      }

      if (events.length === 0 && options.pending) {
        if (routingReminders.length === 0) {
          output.write("[brain] No pending reinforcement suggestions were queued.\n");
        }
        return;
      }

      if (events.length === 0) {
        output.write(`${t("memory.reinforce_none_found", language)}\n`);
        return;
      }

      output.write(`Detected ${events.length} failure event${events.length === 1 ? "" : "s"}:\n`);
      for (const [index, event] of events.entries()) {
        output.write(`${helpers.renderFailureEventLine(index + 1, event)}\n`);
      }

      if (!options.yes) {
        const confirmed = await helpers.confirmReinforcement();
        if (!confirmed) {
          output.write("[brain] reinforcement cancelled.\n");
          return;
        }
      }

      const result = await reinforceMemories(events, getBrainDir(projectRoot));
      if (options.pending) {
        await clearPendingReinforcementEvents(projectRoot);
      }
      await updateIndex(projectRoot);
      output.write(
        `[brain] reinforcement complete: boosted=${result.boosted.length}, rewritten=${result.rewritten.length}, extracted=${result.extracted.length}\n`,
      );
    });

  program;
}
