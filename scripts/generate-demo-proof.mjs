import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const defaultOutputDir = path.join(projectRoot, "docs", "demo-assets", "typescript-cli-proof");
const outputDir = path.resolve(readFlagValue("--output-dir") ?? defaultOutputDir);
const keepWorkspace = process.argv.includes("--keep-workspace");

const storeApiPath = path.join(projectRoot, "dist", "store-api.js");
const extractPath = path.join(projectRoot, "dist", "extract.js");
const injectPath = path.join(projectRoot, "dist", "inject.js");

await assertDistBuilt();

const storeApi = withSourcedWrites(await import(pathToFileURL(storeApiPath).href));
const { extractMemories } = await import(pathToFileURL(extractPath).href);
const { buildInjection } = await import(pathToFileURL(injectPath).href);

function withSourcedWrites(api) {
  return {
    ...api,
    saveMemory(memory, projectRoot, provenance) {
      return api.saveMemory(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
    },
    savePreference(preference, projectRoot, provenance) {
      return api.savePreference(
        preference,
        projectRoot,
        provenance ?? {
          sourceBytes: Buffer.from(preference.reason, "utf8"),
        },
      );
    },
    applyRoutingFeedback(projectRoot, events, options) {
      return api.applyRoutingFeedback(
        projectRoot,
        events,
        options ?? { sourceBytes: Buffer.from(JSON.stringify(events), "utf8") },
      );
    },
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-demo-proof-"));
const sampleRepo = path.join(tempRoot, "typescript-cli-demo");

const config = {
  maxInjectTokens: 1200,
  extractMode: "suggest",
  language: "en",
  staleDays: 30,
  sweepOnInject: false,
};

try {
  await mkdir(sampleRepo, { recursive: true });
  await seedTypeScriptCliRepo(sampleRepo);

  const setupResult = await storeApi.setupRepoBrain(sampleRepo, { gitHook: false });
  const setupOutput = sanitizeText(
    [
      `Initialized RepoBrain in ${sampleRepo}`,
      `- Brain directory: ${setupResult.brainDir}`,
      `- ${setupResult.gitHook.message}`,
      '- Next step: run "brain inject" at session start, or wire it into your agent hook.',
    ].join("\n"),
    sampleRepo,
  );

  const sessionSummary = [
    "gotcha: Normalize CLI env booleans in src/config.ts before Commander validation",
    "",
    "In this TypeScript CLI repo, src/config.ts reads env defaults before src/cli.ts hands control to Commander.",
    "If boolean-like strings are passed through untouched, release smoke validation misreads dry-run flags and package verification becomes noisy.",
    "Normalize boolean env defaults in src/config.ts before wiring them into Commander option parsing.",
    "",
    "Files: src/config.ts, src/cli.ts",
  ].join("\n");

  const extractedMemories = await extractMemories(sessionSummary, config);
  assert.equal(extractedMemories.length, 1, "Expected one extracted demo memory.");

  const initialRecords = await storeApi.loadStoredMemoryRecords(sampleRepo);
  const candidateReviews = extractedMemories.map((memory) => ({
    memory,
    review: storeApi.reviewCandidateMemory(memory, initialRecords),
  }));

  const candidateIds = [];
  for (const entry of candidateReviews) {
    const savedPath = await storeApi.saveMemory(
      {
        ...entry.memory,
        status: "candidate",
      },
      sampleRepo,
    );
    candidateIds.push(path.basename(savedPath, ".md"));
  }

  const extractOutput = sanitizeText(
    [
      `Reviewed ${candidateReviews.length} extracted memory.`,
      ...candidateReviews.map(
        (entry) => `- ${entry.memory.title} | decision=${entry.review.decision} | reason=${entry.review.reason}`,
      ),
      `Saved ${candidateReviews.length} memory as candidates.`,
    ].join("\n"),
    sampleRepo,
  );

  const reviewRecords = await storeApi.loadStoredMemoryRecords(sampleRepo);
  const candidateRecords = reviewRecords.filter((entry) => entry.memory.status === "candidate");
  const reviewOutput = sanitizeText(
    [
      `Candidate memories: ${candidateRecords.length}`,
      ...candidateRecords.map(
        (entry) =>
          `- ${path.basename(entry.filePath, ".md")} | ${entry.memory.type} | ${entry.memory.importance} | ${entry.memory.title}`,
      ),
    ].join("\n"),
    sampleRepo,
  );

  const approvedCount = await approveCandidates(candidateRecords);
  await storeApi.updateIndex(sampleRepo);
  const approveOutput = sanitizeText(`Approved ${approvedCount} safe candidate memory.`, sampleRepo);

  await storeApi.saveMemory(
    {
      type: "decision",
      title: "Release changes should start with checklist and install smoke validation",
      summary:
        "First-release work should route through the release checklist and packaged install smoke validation before publish.",
      detail: [
        "## DECISION",
        "",
        "When package.json, release docs, or publish workflow files change, start with the release checklist.",
        "Use packaged install smoke validation before publish so the first npm release proves installability instead of assuming it.",
      ].join("\n"),
      tags: ["release", "npm", "smoke"],
      importance: "high",
      date: "2026-04-03T09:00:00.000Z",
      status: "active",
      files: ["package.json", "docs/release-checklist.md", "docs/release-guide.md"],
      path_scope: ["package.json", "docs/release-checklist.md", "docs/release-guide.md"],
      required_skills: ["release-checklist"],
      recommended_skills: ["npm-install-smoke"],
      suppressed_skills: ["imagegen"],
      skill_trigger_tasks: ["prepare first npm release", "publish npm release", "release smoke validation"],
      skill_trigger_paths: ["package.json", "docs/release-checklist.md", "docs/release-guide.md"],
      invocation_mode: "prefer",
      risk_level: "medium",
    },
    sampleRepo,
  );

  const injectOutput = sanitizeText(
    await buildInjection(sampleRepo, config, {
      task: "tighten config parsing for npm release smoke validation",
      paths: ["src/config.ts", "src/cli.ts"],
      modules: ["cli"],
    }),
    sampleRepo,
  );

  const suggestResult = await storeApi.buildSkillShortlist(sampleRepo, {
    task: "prepare first npm release smoke validation",
    paths: ["package.json", "docs/release-checklist.md"],
  });
  const suggestMarkdown = sanitizeText(storeApi.renderSkillShortlist(suggestResult), sampleRepo);
  const suggestJson = JSON.stringify(
    sanitizeJson(JSON.parse(storeApi.renderSkillShortlistJson(suggestResult)), sampleRepo),
    null,
    2,
  );

  const brainFiles = await collectBrainFiles(sampleRepo);
  const transcript = renderTranscript({
    sessionSummary,
    setupOutput,
    extractOutput,
    reviewOutput,
    approveOutput,
    injectOutput,
    suggestMarkdown,
    suggestJson,
    brainFiles,
  });

  await rm(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "transcript.md"), transcript, "utf8");
  await writeFile(path.join(outputDir, "session-summary.txt"), sessionSummary, "utf8");
  await writeFile(path.join(outputDir, "invocation-plan.json"), `${suggestJson.trim()}\n`, "utf8");
  await writeFile(path.join(outputDir, "inject-output.md"), `${injectOutput.trim()}\n`, "utf8");
  await writeFile(path.join(outputDir, "review-output.txt"), `${reviewOutput.trim()}\n`, "utf8");
  await writeFile(path.join(outputDir, "workspace-tree.txt"), `${renderTree(brainFiles)}\n`, "utf8");

  for (const relativePath of brainFiles) {
    const sourcePath = path.join(sampleRepo, relativePath);
    const targetPath = path.join(outputDir, relativePath.replace(/^\.brain[\\/]/, ""));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
  }

  process.stdout.write(`Demo proof written to ${outputDir}\n`);
} finally {
  if (!keepWorkspace) {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function assertDistBuilt() {
  try {
    await Promise.all([readFile(storeApiPath, "utf8"), readFile(extractPath, "utf8"), readFile(injectPath, "utf8")]);
  } catch {
    throw new Error('Build output missing. Run "npm run build" before generating demo proof assets.');
  }
}

async function seedTypeScriptCliRepo(sampleRepo) {
  await mkdir(path.join(sampleRepo, "src"), { recursive: true });
  await mkdir(path.join(sampleRepo, "docs"), { recursive: true });

  await writeFile(
    path.join(sampleRepo, "package.json"),
    JSON.stringify(
      {
        name: "demo-ts-cli",
        version: "0.0.1",
        type: "module",
        scripts: {
          build: "tsc -p tsconfig.json",
          start: "node dist/cli.js",
        },
      },
      null,
      2,
    ).concat("\n"),
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ).concat("\n"),
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "src", "config.ts"),
    [
      "export interface CliConfig {",
      "  dryRun: boolean;",
      "}",
      "",
      "export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {",
      "  return {",
      '    dryRun: env.DRY_RUN === "true",',
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "src", "cli.ts"),
    [
      'import { loadConfig } from "./config.js";',
      "",
      "const config = loadConfig(process.env);",
      'console.log(config.dryRun ? "dry" : "live");',
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "docs", "release-checklist.md"),
    "# release checklist\n\n- run smoke validation\n",
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "docs", "release-guide.md"),
    "# release guide\n\nInstall verification lives here.\n",
    "utf8",
  );

  await writeFile(
    path.join(sampleRepo, "README.md"),
    [
      "# demo-ts-cli",
      "",
      "A tiny TypeScript CLI repo used to prove RepoBrain's extract, review, inject, and routing loop.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function approveCandidates(candidateRecords) {
  let approvedCount = 0;
  for (const entry of candidateRecords) {
    const review = storeApi.reviewCandidateMemory(
      entry.memory,
      candidateRecords.filter((record) => record.filePath !== entry.filePath).map((record) => record),
    );
    assert.equal(review.decision, "accept");
    assert.equal(review.reason, "novel_memory");

    await storeApi.overwriteStoredMemory({
      ...entry,
      memory: {
        ...entry.memory,
        status: "active",
      },
    });
    approvedCount += 1;
  }
  return approvedCount;
}

function renderTranscript({
  sessionSummary,
  setupOutput,
  extractOutput,
  reviewOutput,
  approveOutput,
  injectOutput,
  suggestMarkdown,
  suggestJson,
  brainFiles,
}) {
  return [
    "# RepoBrain Demo Proof",
    "",
    "This transcript is generated by `npm run demo:proof` via `scripts/generate-demo-proof.mjs`.",
    "It proves the smallest credible loop in a real TypeScript CLI-shaped repository:",
    "",
    "1. initialize RepoBrain",
    "2. capture a first memory as a candidate",
    "3. review and approve it",
    "4. inject it into the next session",
    "5. derive a task-known invocation plan with `brain suggest-skills`",
    "",
    "## Input Summary",
    "",
    "```text",
    sessionSummary,
    "```",
    "",
    "## Commands And Outputs",
    "",
    "### 1. `brain setup --no-git-hook`",
    "",
    "```text",
    setupOutput.trimEnd(),
    "```",
    "",
    "### 2. `cat session-summary.txt | brain extract --candidate`",
    "",
    "```text",
    extractOutput.trimEnd(),
    "```",
    "",
    "### 3. `brain review`",
    "",
    "```text",
    reviewOutput.trimEnd(),
    "```",
    "",
    "### 4. `brain approve <candidate-id> --safe`",
    "",
    "```text",
    approveOutput.trimEnd(),
    "```",
    "",
    "### 5. `brain inject --task ... --path src/config.ts --path src/cli.ts --module cli`",
    "",
    "```text",
    injectOutput.trimEnd(),
    "```",
    "",
    "### 6. `brain suggest-skills --task ... --path package.json --path docs/release-checklist.md`",
    "",
    "```text",
    suggestMarkdown.trimEnd(),
    "```",
    "",
    "### 7. `brain suggest-skills --format json --task ... --path package.json --path docs/release-checklist.md`",
    "",
    "```json",
    suggestJson.trim(),
    "```",
    "",
    "## Produced `.brain/` Assets",
    "",
    "```text",
    renderTree(brainFiles),
    "```",
    "",
  ].join("\n");
}

async function collectBrainFiles(projectRoot) {
  const root = path.join(projectRoot, ".brain");
  const result = [];
  await walk(root, result);
  return result.map((entry) => path.relative(projectRoot, entry)).sort((left, right) => left.localeCompare(right));
}

async function walk(currentPath, result) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const nextPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(nextPath, result);
      continue;
    }
    result.push(nextPath);
  }
}

function renderTree(relativePaths) {
  return relativePaths.map((entry) => entry.replace(/\\/g, "/")).join("\n");
}

function readFlagValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function sanitizeText(value, sampleRepo) {
  return value.replaceAll(sampleRepo, "<demo-repo>").replaceAll(sampleRepo.replace(/\\/g, "/"), "<demo-repo>");
}

function sanitizeJson(value, sampleRepo) {
  if (typeof value === "string") {
    return sanitizeText(value, sampleRepo);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, sampleRepo));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJson(entry, sampleRepo)]));
  }

  return value;
}
