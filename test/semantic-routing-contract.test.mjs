import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CANONICAL_SEMANTIC_ROUTES,
  SEMANTIC_CONTRACT_PROVENANCE,
  SEMANTIC_CONTRACT_VERSION,
  SEMANTIC_DIMENSIONS,
  deriveSemanticRoute,
  validateSemanticLabels,
} from "../dist/index.js";

const tracker = JSON.parse(readFileSync(new URL("../docs/laya-integration-readiness.json", import.meta.url), "utf8"));
const dimensions = {
  complexity: ["mechanical", "normal", "difficult", "architectural"],
  risk: ["low", "medium", "high"],
  scope: ["isolated", "subsystem", "cross_system"],
  uncertainty: ["low", "medium", "high"],
  prior_failures: ["none", "one", "repeated"],
  root_cause_required: ["no", "yes"],
  architecture_required: ["no", "yes"],
  sensitivity: ["low", "high"],
};
const base = Object.fromEntries(Object.entries(dimensions).map(([key, values]) => [key, values[0]]));

/* Reproduce the independently generated oracle without reading any datasets:
python3 - /path/to/laya-eval <<'PY'
import ast, hashlib, itertools, subprocess, sys
sha = 'cac2aac10c365baf584f32712a34f1eb5e6ef284'
source = subprocess.check_output(['git', '-C', sys.argv[1], 'show', sha + ':dataset_pipeline/core.py'])
assert hashlib.sha256(source).hexdigest() == '81ff5bd5b5111470d9e046e42b98975f91dfe040710378c124db1d59a5649d3a'
nodes = [n for n in ast.parse(source).body if
    (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'DIMENSIONS' for t in n.targets)) or
    (isinstance(n, ast.FunctionDef) and n.name in ('validate_labels', 'route'))]
ns = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'pinned-core.py', 'exec'), ns)
dims = ns['DIMENSIONS']
rows = ['|'.join((*values, ns['route'](dict(zip(dims, values))))) + '\n'
        for values in itertools.product(*dims.values())]
print(len(rows), hashlib.sha256(''.join(rows).encode('utf-8')).hexdigest())
PY
Only unchanged AST nodes from the pinned Python source execute; CI uses its frozen digest.
*/
describe("frozen Laya V2.2 semantic contract", () => {
  it("preserves the exact schema, canonical routes and immutable provenance", () => {
    expect(SEMANTIC_DIMENSIONS).toEqual(dimensions);
    expect(CANONICAL_SEMANTIC_ROUTES).toEqual(["luna", "terra", "sol", "astra"]);
    expect(SEMANTIC_CONTRACT_VERSION).toBe("2.2");
    expect(SEMANTIC_CONTRACT_PROVENANCE).toEqual({
      contract_version: "2.2",
      source_repository: "celleree/laya-eval",
      source_commit: "cac2aac10c365baf584f32712a34f1eb5e6ef284",
      rubric_path: "docs/SEMANTIC_ANNOTATION_RUBRIC_V2_2.md",
      rubric_sha256: "3acd87e1f8f08196ca48979467b818ad104a7213dbd2b1def524dbac20f17708",
      routing_source_path: "dataset_pipeline/core.py",
      routing_source_sha256: "81ff5bd5b5111470d9e046e42b98975f91dfe040710378c124db1d59a5649d3a",
      freeze_artifact_path: "results/semantic_contract_v2_2_freeze.json",
    });
    for (const value of [
      SEMANTIC_CONTRACT_PROVENANCE,
      SEMANTIC_DIMENSIONS,
      CANONICAL_SEMANTIC_ROUTES,
      ...Object.values(SEMANTIC_DIMENSIONS),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const validated = validateSemanticLabels(base);
    expect(validated).toEqual(base);
    expect(validated).not.toBe(base);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it("conforms across all 2,592 states to the pinned Python oracle", () => {
    let states = [[]];
    for (const values of Object.values(dimensions))
      states = states.flatMap((state) => values.map((v) => [...state, v]));
    const digest = createHash("sha256");
    const counts = Object.fromEntries(CANONICAL_SEMANTIC_ROUTES.map((route) => [route, 0]));
    for (const values of states) {
      const route = deriveSemanticRoute(Object.fromEntries(Object.keys(dimensions).map((key, i) => [key, values[i]])));
      counts[route]++;
      digest.update([...values, route].join("|") + "\n", "utf8");
    }
    expect(states).toHaveLength(2592);
    expect(digest.digest("hex")).toBe("1bfb950e7b759ef3eed3c026657092d636574e86e22fe3c9ce3ff0f12cccd9b8");
    expect(counts).toEqual({ luna: 2, terra: 14, sol: 448, astra: 2128 });
    expect(tracker.conformance.state_count).toBe(2592);
    expect(tracker.conformance.sha256).toBe("1bfb950e7b759ef3eed3c026657092d636574e86e22fe3c9ce3ff0f12cccd9b8");
  });

  it.each([
    [{}, "luna"],
    [{ scope: "subsystem" }, "luna"],
    [{ risk: "medium" }, "terra"],
    [{ uncertainty: "medium" }, "terra"],
    [{ complexity: "normal" }, "terra"],
    [{ complexity: "difficult" }, "sol"],
    [{ root_cause_required: "yes" }, "sol"],
    [{ prior_failures: "one" }, "sol"],
    [{ prior_failures: "repeated" }, "sol"],
    [{ uncertainty: "high" }, "sol"],
    [{ scope: "cross_system" }, "sol"],
    [{ sensitivity: "high" }, "sol"],
    [{ architecture_required: "yes" }, "astra"],
    [{ complexity: "architectural" }, "astra"],
    [{ risk: "high" }, "astra"],
    [{ prior_failures: "repeated", uncertainty: "high" }, "astra"],
    [{ prior_failures: "repeated", root_cause_required: "yes" }, "astra"],
    [{ root_cause_required: "yes", uncertainty: "high" }, "sol"],
    [{ root_cause_required: "yes", uncertainty: "high", complexity: "difficult" }, "astra"],
    [{ root_cause_required: "yes", uncertainty: "high", scope: "cross_system" }, "astra"],
  ])("routes boundary %j to %s", (overrides, route) => {
    expect(deriveSemanticRoute({ ...base, ...overrides })).toBe(route);
    expect(deriveSemanticRoute(Object.fromEntries(Object.entries({ ...base, ...overrides }).reverse()))).toBe(route);
  });

  it("rejects missing/extra dimensions, invalid values and malformed records deterministically", () => {
    const rejects = (input, message) => {
      for (const fn of [validateSemanticLabels, deriveSemanticRoute])
        expect(() => fn(input)).toThrow(new TypeError(message));
    };
    for (const input of [null, undefined, [], "labels", 0, true, () => base, new Date(), Object.create(base)]) {
      rejects(input, "labels must be a plain object");
    }
    for (const key of Object.keys(dimensions)) {
      const missing = { ...base };
      delete missing[key];
      rejects(missing, `missing label: ${key}`);
      for (const value of [null, undefined, "", "unknown", "LOW", 1, false, [], {}])
        rejects({ ...base, [key]: value }, `invalid label: ${key}`);
    }
    rejects({ ...base, confidence: 1 }, "unknown label: confidence");
    rejects({ ...base, [Symbol("extra")]: "low" }, "unknown label: Symbol(extra)");
    rejects(Object.defineProperty({ ...base }, "extra", { value: 1 }), "unknown label: extra");
    rejects(Object.defineProperty({ ...base }, "risk", { get: () => "low" }), "invalid label: risk");
    expect(deriveSemanticRoute(Object.assign(Object.create(null), base))).toBe("luna");
  });

  it("records foundation readiness without enabling downstream runtime or inference", () => {
    expect(tracker.provenance).toEqual(SEMANTIC_CONTRACT_PROVENANCE);
    expect([tracker.contract_ready, tracker.global_contract_enabled, tracker.laya_replacement_ready]).toEqual([
      true,
      false,
      false,
    ]);
    expect(tracker.requirements).toHaveLength(22);
    expect(new Set(tracker.requirements.map((r) => r.id)).size).toBe(22);
    for (const requirement of tracker.requirements) {
      expect(["ready", "not_started", "in_progress", "blocked"]).toContain(requirement.status);
      expect(requirement.evidence.length).toBeGreaterThan(0);
    }
    expect(tracker.requirements.filter((r) => r.status === "ready").map((r) => r.id)).toEqual([
      "frozen_v2_2_contract",
      "pinned_laya_provenance",
      "eight_dimension_contract",
      "deterministic_route_parity",
      "exhaustive_conformance",
      "classifier_neutral_input",
    ]);
    expect(tracker.requirements.slice(6).every((r) => r.status === "not_started")).toBe(true);
  });
});
