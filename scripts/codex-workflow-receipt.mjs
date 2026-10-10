import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

// stdout only: never initializes Brain, writes Git state or reads credentials.
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
const metadata = (path) => {
  if (!existsSync(path)) return { path, present: false };
  const bytes = readFileSync(path);
  return { path, present: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const choose = (directory) => {
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const item = metadata(join(directory, name));
    if (item.present && item.bytes > 0) return item;
  }
  return { path: directory, present: false };
};
const head = git('rev-parse', 'HEAD');
const config = join(home, 'config.toml');
const selected = {};
// Only top-level selected defaults; profile resolution belongs to the executor.
if (existsSync(config)) {
  for (const line of readFileSync(config, 'utf8').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*(model|model_reasoning_effort|profile)\s*=\s*"([a-zA-Z0-9._-]{1,100})"\s*(?:#.*)?$/);
    if (match) selected[match[1]] = match[2];
  }
}
const receipt = {
  schema: 'codex-workflow-receipt.v1',
  observedAt: new Date().toISOString(),
  executor: { platform: process.platform, home, node: process.version, selectedDefaults: selected, activeModelVerified: false },
  checkout: { root, branch: git('branch', '--show-current') || null, head, dirty: git('status', '--porcelain=v1').length > 0 },
  guidance: { global: choose(home), checkoutRoot: choose(root), nestedInstructions: 'Resolve applicable ancestor/subdirectory instructions for each target file before editing.' },
  readiness: { status: 'UNVERIFIED', reviewedHead: null, requiredChecks: 'not queried', releaseAuthorized: false },
  limitations: ['Local launch metadata only; selected defaults do not prove active profile/model.', 'No test, GitHub review, deployment, billing or credential data is read.']
};
if (git('rev-parse', 'HEAD') !== head) throw new Error('HEAD changed while collecting receipt; recollect before use.');
console.log(JSON.stringify(receipt, null, 2));
