'use strict';

// Runs the action's `run:` script with a stub `gh` that serves a fixed tag list and
// records every DELETE, so the tests check which tags/releases the action removes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const actionDir = path.resolve(__dirname, '..');

function runScript() {
  const lines = fs.readFileSync(path.join(actionDir, 'action.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s+run: \|$/.test(l)) + 1;
  const indent = lines[start].match(/^\s*/)[0];
  const body = [];
  for (const line of lines.slice(start)) {
    if (line.trim() && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join('\n');
}

const GH_STUB = `#!/usr/bin/env bash
args="$*"
echo "$args" >> "$GH_LOG"
case "$args" in
  *matching-refs/tags/v*) cat "$GH_TAGS" ;;
  "api -X DELETE "*) exit 0 ;;
  *releases/tags/*) tag=\${args##*releases/tags/}; tag=\${tag%% *}; echo "id-$tag" ;;
esac
`;

function run({ branch, tags, prereleaseId = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtar-'));
  fs.writeFileSync(path.join(dir, 'gh'), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tags'), tags.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), runScript());
  const res = spawnSync('bash', ['-eo', 'pipefail', path.join(dir, 'run.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: path.join(dir, 'log'),
      GH_TAGS: path.join(dir, 'tags'),
      GITHUB_ACTION_PATH: actionDir,
      GITHUB_REPOSITORY: 'q4mobile/example',
      BRANCH_NAME: branch,
      BRANCH_NAME_OVERRIDE: '',
      PRERELEASE_ID: prereleaseId,
    },
  });
  const log = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  const deleted = (re) => [...log.matchAll(re)].map((m) => m[1]);
  return {
    status: res.status,
    stdout: res.stdout,
    deletedTags: deleted(/^api -X DELETE repos\/q4mobile\/example\/git\/refs\/tags\/(\S+)$/gm),
    deletedReleases: deleted(/^api -X DELETE repos\/q4mobile\/example\/releases\/id-(\S+)$/gm),
  };
}

// Tags of other branches that must never be touched.
const others = [
  'v1.2.3',
  'v1.2.3-fix-abc-2.1',
  'v1.2.3-other-branch.1',
  'v2.18.1-HRZ-2573-poc-webpack.1',
];

const table = [
  ['HRZ-2573-poc-webpack', ['v2.18.1-hrz-2573-poc-webpack.1', 'v2.18.1-hrz-2573-poc-webpack.2']],
  ['CRMP-215-st2', ['v1.0.11-crmp-215-st-2.1']],
  ['gitStream', ['v1.3.8-git-stream.1']],
  ['CRMh-64', ['v1.8.8-cr-mh-64.1']],
  ['feature/CRMP-88', ['v1.0.2-feature-crmp-88.1']],
  ['fix--x', ['v1.2.3-fix-x.1']],
  ['fix/x_', ['v1.2.3-fix-x.1']],
  ["don't-stop", ['v1.2.3-dont-stop.1']],
  ['HRZ-1234_foo.bar', ['v1.2.3-hrz-1234-foo-bar.1']],
  ['fix-abc', ['v1.2.3-fix-abc.1', 'v1.2.4-fix-abc.3']],
];

for (const [branch, own] of table) {
  test(`deletes only the tags and releases of ${branch}`, () => {
    const r = run({ branch, tags: [...others, ...own] });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.deletedTags, own);
    assert.deepEqual(r.deletedReleases, own);
  });
}

test('logs 0 tags found and succeeds when nothing matches', () => {
  const r = run({ branch: 'HRZ-9999-nothing', tags: others });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /found 0 tag\(s\)/);
  assert.deepEqual(r.deletedTags, []);
});

test('deletes nothing when the branch name has no words', () => {
  const r = run({ branch: '---', tags: [...others, 'v1.2.3--.1'] });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /found 0 tag\(s\)/);
  assert.deepEqual(r.deletedTags, []);
});

test('strips a refs/heads/ prefix from the branch name', () => {
  const r = run({ branch: 'refs/heads/HRZ-1', tags: [...others, 'v1.2.3-hrz-1.1'] });
  assert.deepEqual(r.deletedTags, ['v1.2.3-hrz-1.1']);
});

test('uses prerelease_id instead of computing one', () => {
  const r = run({
    branch: 'HRZ-2573-poc-webpack',
    prereleaseId: 'custom.id-123',
    tags: [...others, 'v1.2.3-custom.id-123.1', 'v1.2.3-customXid-123.1', 'v2.18.1-hrz-2573-poc-webpack.1'],
  });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.deletedTags, ['v1.2.3-custom.id-123.1']);
});

test('rejects a prerelease_id with characters a tag cannot hold', () => {
  const r = run({ branch: 'x', prereleaseId: 'a*b', tags: others });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.deletedTags, []);
});

test('rejects a multi-line prerelease_id even when one line is valid', () => {
  const r = run({ branch: 'x', prereleaseId: 'a\n[0-9]', tags: [...others, 'v1.2.3-a.1'] });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.deletedTags, []);
});
