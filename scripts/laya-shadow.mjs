import { pathToFileURL } from "node:url";

// Offline receipt validation only. No router, model, filesystem or network calls.
const dimensions = {
  complexity: ["mechanical", "normal", "difficult", "architectural"],
  risk: ["low", "medium", "high"],
  scope: ["isolated", "subsystem", "cross_system"],
  uncertainty: ["low", "medium", "high"],
  prior_failures: ["none", "one", "repeated"],
  root_cause_required: ["yes", "no"],
  architecture_required: ["yes", "no"],
  sensitivity: ["low", "high"],
};
const routes = ["Luna", "Terra", "Sol", "Astra"];
const statuses = ["proposed", "abstained", "unavailable", "timeout", "invalid"];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function fail(message) {
  throw new Error(message);
}
function object(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name}: object required`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${name}: unknown field`);
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(`${name}: missing field`);
}
function id(value, name) {
  if (typeof value !== "string" || !identifier.test(value)) fail(`${name}: opaque identifier required`);
}
function choice(value, values, name) {
  if (!values.includes(value)) fail(`${name}: unsupported value`);
}
function metric(value, name) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) fail(`${name}: nonnegative number or null required`);
}

export function validateShadowReceipt(receipt) {
  object(
    receipt,
    ["schema_version", "task_id", "source", "labeler_id", "labels", "existing_route", "shadow", "outcome"],
    "receipt",
  );
  choice(receipt.schema_version, ["laya-shadow.v1"], "schema_version");
  id(receipt.task_id, "task_id");
  id(receipt.labeler_id, "labeler_id");
  // An operator attestation, not a claim that code can detect holdout derivation.
  choice(receipt.source, ["new_operator_task"], "source");
  object(receipt.labels, Object.keys(dimensions), "labels");
  for (const [key, values] of Object.entries(dimensions)) {
    choice(receipt.labels[key], [...values, null], `labels.${key}`);
  }
  choice(receipt.existing_route, routes, "existing_route");
  object(receipt.shadow, ["status", "proposed_route", "candidate_id", "contract_commit", "latency_ms"], "shadow");
  choice(receipt.shadow.status, statuses, "shadow.status");
  metric(receipt.shadow.latency_ms, "shadow.latency_ms");
  if (receipt.shadow.status === "proposed") {
    choice(receipt.shadow.proposed_route, routes, "shadow.proposed_route");
    id(receipt.shadow.candidate_id, "shadow.candidate_id");
    if (!/^[a-f0-9]{40}$/.test(receipt.shadow.contract_commit ?? "")) fail("shadow.contract_commit: full SHA required");
    if (Object.values(receipt.labels).includes(null)) fail("proposed route requires non-abstaining labels");
  } else if (
    receipt.shadow.proposed_route !== null ||
    receipt.shadow.candidate_id !== null ||
    receipt.shadow.contract_commit !== null
  ) {
    fail("non-proposed shadow requires null route and candidate provenance");
  }
  object(receipt.outcome, ["status", "rework_count", "wall_time_ms", "observed_usage", "evidence_id"], "outcome");
  choice(receipt.outcome.status, ["pending", "completed", "failed", "cancelled"], "outcome.status");
  metric(receipt.outcome.rework_count, "outcome.rework_count");
  if (receipt.outcome.rework_count !== null && !Number.isInteger(receipt.outcome.rework_count))
    fail("rework_count: integer required");
  metric(receipt.outcome.wall_time_ms, "outcome.wall_time_ms");
  if (receipt.outcome.evidence_id !== null) id(receipt.outcome.evidence_id, "outcome.evidence_id");
  if (receipt.outcome.status !== "pending" && receipt.outcome.evidence_id === null)
    fail("finished outcome requires evidence_id");
  if (receipt.outcome.observed_usage !== null) {
    object(receipt.outcome.observed_usage, ["unit", "value", "evidence_id"], "observed_usage");
    choice(receipt.outcome.observed_usage.unit, ["tokens", "credits"], "observed_usage.unit");
    metric(receipt.outcome.observed_usage.value, "observed_usage.value");
    if (receipt.outcome.observed_usage.value === null) fail("observed_usage.value: measured value required");
    id(receipt.outcome.observed_usage.evidence_id, "observed_usage.evidence_id");
  }
  return receipt;
}

export function summarizeShadowReceipts(receipts) {
  if (!Array.isArray(receipts)) fail("input: JSON array required");
  const seen = new Set();
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  let agreements = 0;
  let completed = 0;
  let usageObserved = 0;
  for (const receipt of receipts) {
    validateShadowReceipt(receipt);
    if (seen.has(receipt.task_id)) fail("duplicate task_id; supply one latest receipt per task");
    seen.add(receipt.task_id);
    counts[receipt.shadow.status]++;
    if (receipt.shadow.status === "proposed" && receipt.shadow.proposed_route === receipt.existing_route) agreements++;
    if (receipt.outcome.status === "completed") completed++;
    if (receipt.outcome.observed_usage !== null) usageObserved++;
  }
  return {
    schema_version: "laya-shadow-summary.v1",
    global_routing_enabled: false,
    replacement_ready: false,
    tasks: receipts.length,
    shadow_status_counts: counts,
    route_comparisons: counts.proposed,
    route_agreements: agreements,
    fallback_to_existing_route: receipts.length - counts.proposed,
    completed_existing_route_tasks: completed,
    tasks_with_observed_usage: usageObserved,
    limitations: [
      "operator_attested_new_tasks",
      "route_agreement_is_not_accuracy",
      "only_existing_route_executed",
      "no_counterfactual_cost_or_completion_measurement",
      "no_activation_readiness_claim",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    let receipts;
    try {
      receipts = JSON.parse(input);
    } catch {
      fail("input: valid JSON required");
    }
    console.log(JSON.stringify(summarizeShadowReceipts(receipts), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid input");
    process.exitCode = 1;
  }
}
