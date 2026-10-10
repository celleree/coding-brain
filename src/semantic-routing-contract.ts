/** Frozen semantic contract only; execution mapping and runtime activation are downstream. */
export const SEMANTIC_CONTRACT_VERSION = "2.2";
export const SEMANTIC_CONTRACT_PROVENANCE = Object.freeze({
  contract_version: SEMANTIC_CONTRACT_VERSION,
  source_repository: "celleree/laya-eval",
  source_commit: "cac2aac10c365baf584f32712a34f1eb5e6ef284",
  rubric_path: "docs/SEMANTIC_ANNOTATION_RUBRIC_V2_2.md",
  rubric_sha256: "3acd87e1f8f08196ca48979467b818ad104a7213dbd2b1def524dbac20f17708",
  routing_source_path: "dataset_pipeline/core.py",
  routing_source_sha256: "81ff5bd5b5111470d9e046e42b98975f91dfe040710378c124db1d59a5649d3a",
  freeze_artifact_path: "results/semantic_contract_v2_2_freeze.json",
});

export const SEMANTIC_DIMENSIONS = Object.freeze({
  complexity: Object.freeze(["mechanical", "normal", "difficult", "architectural"] as const),
  risk: Object.freeze(["low", "medium", "high"] as const),
  scope: Object.freeze(["isolated", "subsystem", "cross_system"] as const),
  uncertainty: Object.freeze(["low", "medium", "high"] as const),
  prior_failures: Object.freeze(["none", "one", "repeated"] as const),
  root_cause_required: Object.freeze(["no", "yes"] as const),
  architecture_required: Object.freeze(["no", "yes"] as const),
  sensitivity: Object.freeze(["low", "high"] as const),
});
export type SemanticLabels = {
  readonly [K in keyof typeof SEMANTIC_DIMENSIONS]: (typeof SEMANTIC_DIMENSIONS)[K][number];
};
export const CANONICAL_SEMANTIC_ROUTES = Object.freeze(["luna", "terra", "sol", "astra"] as const);
export type CanonicalSemanticRoute = (typeof CANONICAL_SEMANTIC_ROUTES)[number];

/** Classifier-neutral boundary: accept complete labels, reject abstentions and malformed records. */
export function validateSemanticLabels(input: unknown): SemanticLabels {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("labels must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("labels must be a plain object");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !Object.hasOwn(SEMANTIC_DIMENSIONS, key)) {
      throw new TypeError(`unknown label: ${String(key)}`);
    }
  }
  const labels: Record<string, string> = {};
  for (const [key, values] of Object.entries(SEMANTIC_DIMENSIONS)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) throw new TypeError(`missing label: ${key}`);
    if (
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !values.some((v) => v === descriptor.value)
    ) {
      throw new TypeError(`invalid label: ${key}`);
    }
    labels[key] = descriptor.value;
  }
  return Object.freeze(labels) as SemanticLabels;
}

/** Exact ordered port of pinned dataset_pipeline/core.py::route(labels); no safety floor. */
export function deriveSemanticRoute(input: unknown): CanonicalSemanticRoute {
  const {
    complexity: c,
    risk: r,
    scope: s,
    uncertainty: u,
    prior_failures: p,
    root_cause_required: root,
    architecture_required: arch,
    sensitivity: sensitive,
  } = validateSemanticLabels(input);
  if (arch === "yes" || c === "architectural" || r === "high") return "astra";
  if (p === "repeated" && (u === "high" || root === "yes")) return "astra";
  if (root === "yes" && u === "high" && (c === "difficult" || s === "cross_system")) return "astra";
  if (
    c === "difficult" ||
    root === "yes" ||
    p !== "none" ||
    u === "high" ||
    s === "cross_system" ||
    sensitive === "high"
  ) {
    return "sol";
  }
  if (c === "mechanical" && r === "low" && u === "low") return "luna";
  return "terra";
}
