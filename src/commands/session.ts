import { Command } from "commander";
import path from "node:path";
import { stdout as output } from "node:process";
import { loadConfig } from "../config.js";
import { extractPreferenceFromNaturalLanguage } from "../extract-preference.js";
import { t } from "../i18n.js";
import {
  clearSessionProfile,
  combinedPromoteText,
  defaultSessionProfile,
  getSessionProfilePath,
  loadSessionProfile,
  mergeHints,
  saveSessionProfile,
  upsertSkillRouting,
} from "../session-profile.js";
import { initBrain, saveMemory, savePreference } from "../store.js";
import type { Memory, Preference } from "../types.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("session-set")
    .description("Store ephemeral session hints under `.brain/runtime/` (local-only; not durable repo knowledge).")
    .argument("[text...]", "Free-form hint lines (optional if workflow or skill flags are set)")
    .option("--replace", "Replace existing hints instead of merging")
    .option("--minimal-change", "Prefer minimal edits this session")
    .option("--skip-full-tests", "Avoid running the full test suite this session when reasonable")
    .option("--no-schema-changes", "Avoid schema or migration changes this session")
    .option("--light-debug", "Prefer a lightweight debugging path this session")
    .option("--prefer-skill <skill>", "Session routing: prefer this skill (overrides ordinary preferences)")
    .option("--avoid-skill <skill>", "Session routing: avoid this skill")
    .option("--review-skill <skill>", "Session routing: require human review before using this skill")
    .action(
      async (
        texts: string[],
        options: {
          replace?: boolean;
          minimalChange?: boolean;
          skipFullTests?: boolean;
          noSchemaChanges?: boolean;
          lightDebug?: boolean;
          preferSkill?: string;
          avoidSkill?: string;
          reviewSkill?: string;
        },
      ) => {
        const projectRoot = await helpers.resolveProjectRoot();
        await initBrain(projectRoot);
        const { language } = await loadConfig(projectRoot);

        const textLine = texts
          .map((t) => t.trim())
          .filter(Boolean)
          .join("\n")
          .trim();
        const hasFlags =
          Boolean(options.minimalChange) ||
          Boolean(options.skipFullTests) ||
          Boolean(options.noSchemaChanges) ||
          Boolean(options.lightDebug) ||
          Boolean(options.preferSkill?.trim()) ||
          Boolean(options.avoidSkill?.trim()) ||
          Boolean(options.reviewSkill?.trim());

        if (!textLine && !hasFlags) {
          throw new Error(
            "Provide hint text, workflow flags (--minimal-change, ...), or skill routing flags (--prefer-skill, ...).",
          );
        }

        let profile = (await loadSessionProfile(projectRoot)) ?? defaultSessionProfile();
        const mode = options.replace ? "replace" : "append";

        if (textLine) {
          const lines = textLine
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          profile.hints = mergeHints(mode === "replace" ? [] : profile.hints, lines, mode);
        } else if (options.replace) {
          profile.hints = [];
        }

        profile.workflow_flags = {
          ...profile.workflow_flags,
          ...(options.minimalChange ? { minimal_change: true } : {}),
          ...(options.skipFullTests ? { skip_full_tests: true } : {}),
          ...(options.noSchemaChanges ? { no_schema_changes: true } : {}),
          ...(options.lightDebug ? { light_debug: true } : {}),
        };

        if (options.preferSkill?.trim()) {
          profile = upsertSkillRouting(profile, options.preferSkill.trim(), "prefer");
        }
        if (options.avoidSkill?.trim()) {
          profile = upsertSkillRouting(profile, options.avoidSkill.trim(), "avoid");
        }
        if (options.reviewSkill?.trim()) {
          profile = upsertSkillRouting(profile, options.reviewSkill.trim(), "require_review");
        }

        await saveSessionProfile(projectRoot, profile);
        output.write(`${t("session.profile_updated", language, { path: getSessionProfilePath(projectRoot) })}\n`);
        output.write(`${t("session.profile_saved_local_runtime", language)}\n`);
      },
    );

  program;

  program
    .command("session-show")
    .description("Print the current session profile from `.brain/runtime/session-profile.json`.")
    .option("--json", "Print JSON only")
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const { language } = await loadConfig(projectRoot);
      const profile = await loadSessionProfile(projectRoot);
      if (!profile) {
        output.write(`${t("session.no_profile", language)}\n`);
        return;
      }
      if (options.json) {
        output.write(`${JSON.stringify(profile, null, 2)}\n`);
        return;
      }
      output.write(`File: ${getSessionProfilePath(projectRoot)}\n\n`);
      output.write(`${JSON.stringify(profile, null, 2)}\n`);
    });

  program;

  program
    .command("session-clear")
    .description("Delete the local session profile file (`.brain/runtime/session-profile.json`).")
    .action(async () => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);
      const { language } = await loadConfig(projectRoot);
      await clearSessionProfile(projectRoot);
      output.write(`${t("session.profile_cleared", language)}\n`);
    });

  program;

  program
    .command("session-promote")
    .description(
      "Promote session text into `.brain/preferences/` or durable memory. Session runtime is never written automatically.",
    )
    .requiredOption("--to <target>", "`preference` or `memory`")
    .option("--title <title>", "Title for promoted memory (memory target only)")
    .option("--type <type>", "Memory type when --to memory", "working")
    .option("--text <text>", "Override text used for extraction (defaults to combined session hints)")
    .action(async (options: { to: string; title?: string; type?: string; text?: string }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);
      const { language } = await loadConfig(projectRoot);
      const profile = await loadSessionProfile(projectRoot);
      if (!profile) {
        throw new Error("No session profile to promote. Use `brain session-set` first.");
      }

      const target = options.to.trim().toLowerCase();
      if (target !== "preference" && target !== "memory") {
        throw new Error("Expected --to preference or --to memory.");
      }

      const body = options.text?.trim() || combinedPromoteText(profile);
      if (!body) {
        throw new Error("Session profile is empty; nothing to promote.");
      }

      if (target === "preference") {
        const preference = extractPreferenceFromNaturalLanguage(body, "session-promote");
        if (!preference) {
          throw new Error(
            "Could not extract a routing preference from session text. " +
              "Try a clearer sentence, use `brain capture-preference`, or promote with `--to memory`.",
          );
        }
        const savedPath = await savePreference(preference, projectRoot, { sourceBytes: Buffer.from(body, "utf8") });
        output.write(`${t("session.preference_saved", language, { path: savedPath })}\n`);
        return;
      }

      const memoryType = helpers.parseMemoryTypeOption(options.type ?? "working");
      const title =
        options.title?.trim() ||
        body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0)
          ?.slice(0, 120) ||
        "Session profile promotion";

      const now = new Date().toISOString();
      const memory: Memory = {
        type: memoryType,
        title,
        summary: body.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 280),
        detail: `## Notes\n\n${body}\n`,
        tags: ["session-promote"],
        importance: "medium",
        date: now,
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: now,
        stale: false,
        source: "manual",
        status: memoryType === "goal" ? "active" : "active",
      };

      const savedPath = await saveMemory(memory, projectRoot, { sourceBytes: Buffer.from(body, "utf8") });
      output.write(`${t("session.memory_saved", language, { path: savedPath })}\n`);
    });

  program;
}
