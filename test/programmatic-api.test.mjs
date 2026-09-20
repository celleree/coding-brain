import { describe, expect, it } from "vitest";

import * as api from "../src/index.ts";

describe("programmatic API entry", () => {
  it("exports the documented runtime functions", () => {
    expect(typeof api.loadConfig).toBe("function");
    expect(typeof api.loadAllMemories).toBe("function");
    expect(typeof api.loadStoredMemoryRecords).toBe("function");
    expect(typeof api.loadAllPreferences).toBe("function");
    expect(typeof api.saveMemory).toBe("function");
    expect(typeof api.initBrain).toBe("function");
    expect(typeof api.buildInjection).toBe("function");
    expect(typeof api.buildConversationStart).toBe("function");
    expect(typeof api.buildSkillShortlist).toBe("function");
    expect(typeof api.buildTaskRoutingBundle).toBe("function");
    expect(typeof api.buildAgentNavigationPlan).toBe("function");
    expect(typeof api.extractMemories).toBe("function");
    expect(typeof api.reviewCandidateMemory).toBe("function");
    expect(typeof api.reviewCandidateMemories).toBe("function");
  });
});
