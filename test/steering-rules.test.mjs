import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { getSteeringRulesStatus, writeSteeringRules } from "../dist/store-api.js";

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
};

const SHARED_CONTRACT_PHRASES = [
  "brain start --format json",
  "brain capture",
  "brain suggest-skills --format json",
  "brain reinforce",
  "candidate",
  ".brain/",
  "navigation_plan",
];

const DEV_FALLBACK_PHRASES = ["npx brain", "node dist/cli.js", "brain --version"];

const DETECTION_TRIGGER_PHRASES = [
  "move on / ship it / ready for review",
  "implementation complete / all tests passing",
  "4+",
];

const PHASE_COMPLETION_PHRASES = ["confidence booster", "好的 / 谢谢 / ok / thanks / 嗯 / 收到", "should_extract=true"];

const ANTI_REPETITION_PHRASE = "capture 建议";
const CANDIDATE_FIRST_PHRASE = "candidate";

const SAME_SESSION_REFRESH_PHRASES = [
  'brain conversation-start --format json --task "<当前任务描述>" --path <已变更路径>',
  "`start`、`inject` 还是 `skip`",
];

await runTest("writeSteeringRules writes all three agent rules", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    assert.equal(paths.length, 3);
    assert.ok(paths.some((p) => p.includes("claude")));
    assert.ok(paths.some((p) => p.includes("codex")));
    assert.ok(paths.some((p) => p.includes("cursor")));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules share the same core contract phrases", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      for (const phrase of SHARED_CONTRACT_PHRASES) {
        assert.ok(content.includes(phrase), `${relativePath} is missing shared contract phrase: ${phrase}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include detection trigger conditions", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      for (const phrase of DETECTION_TRIGGER_PHRASES) {
        assert.ok(content.includes(phrase), `${relativePath} is missing detection trigger phrase: ${phrase}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include anti-repetition guidance", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      assert.ok(content.includes(ANTI_REPETITION_PHRASE), `${relativePath} is missing anti-repetition guidance`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include same-session fresh conversation refresh guidance", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      for (const phrase of SAME_SESSION_REFRESH_PHRASES) {
        assert.ok(content.includes(phrase), `${relativePath} is missing same-session refresh phrase: ${phrase}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules default to candidate-first", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      assert.ok(content.includes(CANDIDATE_FIRST_PHRASE), `${relativePath} is missing candidate-first wording`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include failure path via brain reinforce", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      assert.ok(content.includes("brain reinforce"), `${relativePath} is missing failure path (brain reinforce)`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("cursor generated rules include alwaysApply frontmatter", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    await writeSteeringRules(tmpDir, "cursor");
    const cursorPath = path.join(tmpDir, ".cursor", "rules", "brain-session.mdc");
    const content = await readFile(cursorPath, "utf8");
    assert.ok(content.includes("alwaysApply: true"));
    assert.ok(content.includes("brain capture"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include phase-completion signal guidance with weak-signal suppression", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      for (const phrase of PHASE_COMPLETION_PHRASES) {
        assert.ok(content.includes(phrase), `${relativePath} is missing phase-completion phrase: ${phrase}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("no generated rule references old subjective extract-proposal pattern", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      assert.ok(
        !content.includes("主动提议提取记忆"),
        `${relativePath} still contains old subjective extract-proposal pattern`,
      );
      assert.ok(!content.includes("提议示例"), `${relativePath} still contains old example-proposal pattern`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("all generated rules include dev-fallback command resolution", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const paths = await writeSteeringRules(tmpDir, "all");
    for (const relativePath of paths) {
      const content = await readFile(path.join(tmpDir, relativePath), "utf8");
      for (const phrase of DEV_FALLBACK_PHRASES) {
        assert.ok(content.includes(phrase), `${relativePath} is missing dev-fallback phrase: ${phrase}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("integration template files include dev-fallback command resolution", async () => {
  const templateFiles = [
    "integrations/cursor/repobrain.mdc",
    "integrations/codex/SKILL.md",
    "integrations/copilot/copilot-instructions.md",
    "integrations/claude/SKILL.md",
  ];
  const projectRoot = process.cwd();

  for (const templatePath of templateFiles) {
    const content = await readFile(path.join(projectRoot, templatePath), "utf8");
    for (const phrase of DEV_FALLBACK_PHRASES) {
      assert.ok(content.includes(phrase), `${templatePath} is missing dev-fallback phrase: ${phrase}`);
    }
  }
});

await runTest("integration template files align with generated steering rules on core phrases", async () => {
  const templateFiles = [
    "integrations/cursor/repobrain.mdc",
    "integrations/codex/SKILL.md",
    "integrations/copilot/copilot-instructions.md",
    "integrations/claude/SKILL.md",
  ];
  const projectRoot = process.cwd();

  for (const templatePath of templateFiles) {
    const content = await readFile(path.join(projectRoot, templatePath), "utf8");
    assert.ok(content.includes("brain capture"), `${templatePath} is missing brain capture`);
    assert.ok(content.includes("candidate"), `${templatePath} is missing candidate-first wording`);
    assert.ok(content.includes("brain reinforce"), `${templatePath} is missing failure path`);
    assert.ok(content.includes(".brain/"), `${templatePath} is missing .brain/ reference`);
    assert.ok(content.includes("navigation_plan"), `${templatePath} is missing navigation_plan consumption`);
    assert.ok(
      content.includes("fresh conversation") || content.includes("新 conversation"),
      `${templatePath} is missing same-session fresh conversation guidance`,
    );
    assert.ok(
      content.includes("brain conversation-start --format json --task") &&
        (content.includes("brain inject") || content.includes("`inject`")),
      `${templatePath} is missing smart conversation refresh guidance`,
    );
  }
});

await runTest("getSteeringRulesStatus returns false for empty directory", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    const status = await getSteeringRulesStatus(tmpDir);
    assert.equal(status.claudeConfigured, false);
    assert.equal(status.codexConfigured, false);
    assert.equal(status.cursorConfigured, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("getSteeringRulesStatus returns true after write", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "brain-steering-"));
  try {
    await writeSteeringRules(tmpDir, "all");
    const status = await getSteeringRulesStatus(tmpDir);
    assert.equal(status.claudeConfigured, true);
    assert.equal(status.codexConfigured, true);
    assert.equal(status.cursorConfigured, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

console.log("All steering rules tests passed.");
