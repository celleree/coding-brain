import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config.js";
import { extractPreferenceFromNaturalLanguage } from "../extract-preference.js";
import { t } from "../i18n.js";
import { BrainUserError } from "../errors.js";
import {
  loadStoredPreferenceRecords,
  normalizePreference,
  overwriteStoredPreference,
  rewriteStoredPreferenceFormatting,
  savePreference,
  savePreferenceWithSupersessions,
  validatePreference,
  verifyPreferenceProvenance,
} from "../store.js";
import type { Preference } from "../types.js";
import { PREFERENCE_TARGET_TYPES, PREFERENCE_VALUES } from "../types.js";
import { buildActivePreferenceListViewModel } from "../tui/adapters/preferences.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("capture-preference")
    .description("Capture a workflow or skill preference from natural language or explicit parameters.")
    .option("--target <target>", "The name of the skill, workflow, or task class.")
    .option("--type <type>", `Target type: ${PREFERENCE_TARGET_TYPES.join(" | ")}`)
    .option("--pref <value>", `Preference value: ${PREFERENCE_VALUES.join(" | ")}`)
    .option("--reason <reason>", "Reason for this preference.")
    .option("--input <text>", "Natural language input to extract preference from.")
    .action(async (options: { target?: string; type?: any; pref?: any; reason?: string; input?: string }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const { language } = await loadConfig(projectRoot);
      let preference: Preference | null = null;
      let sourceBytes: Buffer | undefined;

      const explicitManual =
        Boolean(options.target?.trim()) &&
        Boolean(options.type) &&
        Boolean(options.pref) &&
        Boolean(options.reason?.trim());

      if (explicitManual) {
        sourceBytes = Buffer.from(options.reason!.trim(), "utf8");
        const now = new Date().toISOString();
        preference = {
          kind: "routing_preference",
          target_type: options.type,
          target: options.target!.trim(),
          preference: options.pref,
          reason: options.reason!.trim(),
          confidence: 1.0,
          source: "manual",
          created_at: now,
          updated_at: now,
          status: "active",
        };
      } else {
        let nl = options.input?.trim();
        if (!nl && !input.isTTY) {
          const payload = await helpers.readStdinPayload();
          nl = payload.text.trim();
          sourceBytes = payload.bytes;
        } else if (nl) {
          sourceBytes = Buffer.from(options.input ?? nl, "utf8");
        }
        if (nl) {
          preference = extractPreferenceFromNaturalLanguage(nl);
          if (!preference) {
            throw new BrainUserError(t("preference.extract_failed", language));
          }
        } else {
          throw new BrainUserError(t("preference.input_required", language));
        }
      }

      const savedPath = await savePreference(preference!, projectRoot, sourceBytes ? { sourceBytes } : {});
      output.write(`${t("preference.saved", language, { path: savedPath })}\n`);
    });

  program;

  program
    .command("list-preferences")
    .description("List all active workflow and skill preferences.")
    .action(async () => {
      const projectRoot = await helpers.resolveProjectRoot();
      const viewModel = await buildActivePreferenceListViewModel(projectRoot);

      if (viewModel.active.length === 0) {
        output.write("No active preferences found.\n");
        return;
      }

      output.write("Active Preferences:\n");
      viewModel.active.forEach((p) => {
        output.write(`- [${p.preference}] ${p.targetType}:${p.target} (Reason: ${p.reason})\n`);
      });
    });

  program;

  program
    .command("dismiss-preference")
    .description("Mark a preference as stale/dismissed.")
    .argument("<target>", "The target name to dismiss preferences for.")
    .action(async (target: string) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const nowIso = new Date().toISOString();
      let count = 0;
      const records = await loadStoredPreferenceRecords(projectRoot);
      for (const rec of records) {
        if (rec.preference.target === target.trim() && rec.preference.status === "active") {
          await overwriteStoredPreference({
            ...rec,
            preference: normalizePreference({
              ...rec.preference,
              status: "stale",
              updated_at: nowIso,
              valid_until: rec.preference.valid_until ?? nowIso,
              supersession_reason: rec.preference.supersession_reason ?? "Dismissed via brain dismiss-preference",
            }),
          });
          count += 1;
        }
      }
      output.write(`Dismissed ${count} preference(s) for ${target}.\n`);
    });

  program;

  program
    .command("supersede-preference")
    .description("Supersede an old preference with a new one.")
    .argument("<old_target>", "The target name to supersede.")
    .option("--target <target>", "The new target name.")
    .option("--type <type>", `Target type: ${PREFERENCE_TARGET_TYPES.join(" | ")}`)
    .option("--pref <value>", `Preference value: ${PREFERENCE_VALUES.join(" | ")}`)
    .option("--reason <reason>", "Reason for this new preference.")
    .action(async (oldTarget: string, options: { target?: string; type?: any; pref?: any; reason?: string }) => {
      if (!options.target?.trim() || !options.type || !options.pref || !options.reason?.trim()) {
        throw new BrainUserError(
          "supersede-preference requires --target, --type, --pref, and --reason for the new preference.",
        );
      }

      const projectRoot = await helpers.resolveProjectRoot();
      const now = new Date().toISOString();
      const newPref: Preference = {
        kind: "routing_preference",
        target_type: options.type,
        target: options.target!.trim(),
        preference: options.pref,
        reason: options.reason!.trim(),
        confidence: 1.0,
        source: "manual",
        created_at: now,
        updated_at: now,
        status: "candidate",
        valid_from: now.slice(0, 10),
        observed_at: now,
        review_state: "cleared",
      };
      const { filePath: savedPath, supersededCount: count } = await savePreferenceWithSupersessions(
        newPref,
        projectRoot,
        oldTarget,
        { sourceBytes: Buffer.from(options.reason!.trim(), "utf8") },
      );

      output.write(`Superseded ${count} old preference(s). New preference saved to: ${savedPath}\n`);
    });

  program;

  program
    .command("lint-preferences")
    .description("Validate all preference files against schema.")
    .action(async () => {
      const projectRoot = await helpers.resolveProjectRoot();
      const records = await loadStoredPreferenceRecords(projectRoot);
      let errors = 0;
      for (const record of records) {
        const p = record.preference;
        try {
          validatePreference(p);
          const provenance = await verifyPreferenceProvenance(projectRoot, p, record.relativePath);
          if (!provenance.ok) throw new Error(provenance.reason);
        } catch (e: any) {
          process.stderr.write(`Lint error in preference for ${p.target}: ${e.message}\n`);
          errors++;
        }
      }
      if (errors === 0) {
        output.write("All preferences are valid.\n");
      } else {
        output.write(`Found ${errors} error(s) in preferences.\n`);
        throw new BrainUserError(`Found ${errors} error(s) in preferences.`);
      }
    });

  program;

  program
    .command("normalize-preferences")
    .description("Normalize all preference files (formatting, fields).")
    .action(async () => {
      const projectRoot = await helpers.resolveProjectRoot();
      const records = await loadStoredPreferenceRecords(projectRoot);
      for (const rec of records) {
        await rewriteStoredPreferenceFormatting(rec);
      }
      output.write(`Normalized ${records.length} preference(s).\n`);
    });

  program;
}
