import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir, hasBrain, writeDefaultConfig } from "../config.js";
import { ensureSessionRuntimeLayout } from "../session-profile.js";
import { ensureOrchestratorStorageLayout } from "./orchestrator-store.js";

export async function initBrain(projectRoot: string): Promise<void> {
  const brainDir = getBrainDir(projectRoot);
  const existedBeforeInit = await hasBrain(projectRoot);
  await mkdir(brainDir, { recursive: true });
  await ensureSessionRuntimeLayout(projectRoot);
  await ensureOrchestratorStorageLayout(projectRoot);
  await Promise.all([
    mkdir(path.join(brainDir, "decisions"), { recursive: true }),
    mkdir(path.join(brainDir, "gotchas"), { recursive: true }),
    mkdir(path.join(brainDir, "conventions"), { recursive: true }),
    mkdir(path.join(brainDir, "patterns"), { recursive: true }),
    mkdir(path.join(brainDir, "working"), { recursive: true }),
    mkdir(path.join(brainDir, "goals"), { recursive: true }),
    mkdir(path.join(brainDir, "preferences"), { recursive: true }),
  ]);

  if (!existedBeforeInit) {
    await writeDefaultConfig(projectRoot);
  } else {
    try {
      await readFile(path.join(brainDir, "config.yaml"), "utf8");
    } catch {
      await writeDefaultConfig(projectRoot);
    }
  }

  const { updateIndex } = await import("./memory-store.js");
  await Promise.all([touchFile(path.join(brainDir, "errors.log")), updateIndex(projectRoot)]);
}

export async function appendErrorLog(projectRoot: string, message: string): Promise<void> {
  const brainDir = getBrainDir(projectRoot);
  await mkdir(brainDir, { recursive: true });
  await appendFile(path.join(brainDir, "errors.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

async function touchFile(filePath: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, "", "utf8");
  }
}
