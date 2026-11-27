'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, createClient, deleteOrphans, main, parseArgs } = require('../scripts/cleanup-orphans');

const NOW = new Date('2026-11-27T00:00:00Z');
const OLD = '2026-09-01T00:00:00Z';
const RECENT = '2026-11-20T00:00:00Z';
const CUTOFF = new Date('2026-10-28T00:00:00Z');

const tag = (name, date = OLD) => ({ name, date });

test('a tag of a deleted branch older than the cutoff is an orphan', () => {
  const r = classify({
    branches: ['main'],
    tags: [tag('v1.2.3-hrz-1.1')],
    releases: new Map([['v1.2.3-hrz-1.1', { id: 7, createdAt: OLD }]]),
    cutoff: CUTOFF,
  });
  assert.deepEqual(r.orphans.map((o) => [o.tag, o.releaseId]), [['v1.2.3-hrz-1.1', 7]]);
});

test('keeps tags of live branches, including names that differ only in case or punctuation', () => {
  const tags = [
    'v1.0.0-hrz-2573-poc-rspack-1.1', // v3 id of HRZ-2573-poc-rspack1
    'v1.0.0-HRZ-2573-poc-rspack1.2', // v2-style id of the same branch
    'v1.0.1-git-stream.1', // gitStream
    'v1.0.2-fix-x.1', // Fix_X
    'v1.0.3-feature-crmp-88.1', // feature/CRMP-88
  ].map((n) => tag(n));
  const r = classify({
    branches: ['HRZ-2573-poc-rspack1', 'gitStream', 'Fix_X', 'feature/CRMP-88'],
    tags,
    releases: new Map(),
    cutoff: CUTOFF,
  });
  assert.deepEqual(r.orphans, []);
  assert.equal(r.kept.liveBranch, 4);
  assert.equal(r.kept.liveBranchLoose, 1);
});

test('a live branch does not protect tags of a branch that only shares a prefix', () => {
  const r = classify({
    branches: ['fix-abc'],
    tags: [tag('v1.2.3-fix-abc.1'), tag('v1.2.3-fix-abc-2.1')],
    releases: new Map(),
    cutoff: CUTOFF,
  });
  assert.deepEqual(r.orphans.map((o) => o.tag), ['v1.2.3-fix-abc-2.1']);
});

test('keeps tags newer than the cutoff, by tag date or release date', () => {
  const r = classify({
    branches: [],
    tags: [tag('v1.0.0-a.1', RECENT), tag('v1.0.0-b.1', OLD)],
    releases: new Map([['v1.0.0-b.1', { id: 1, createdAt: RECENT }]]),
    cutoff: CUTOFF,
  });
  assert.deepEqual(r.orphans, []);
  assert.equal(r.kept.newerThanCutoff, 2);
});

test('keeps tags with no date and ignores tags that are not prereleases', () => {
  const r = classify({
    branches: [],
    tags: [tag('v1.0.0-a.1', null), tag('v1.0.0'), tag('latest'), tag('v1.0.0-a')],
    releases: new Map(),
    cutoff: CUTOFF,
  });
  assert.deepEqual(r.orphans, []);
  assert.equal(r.kept.unknownDate, 1);
  assert.equal(r.notPrerelease, 3);
});

// In-memory GitHub: serves branches/tags/releases and applies DELETEs.
function fakeGitHub({ branches, tags, releases }) {
  const state = { tags: new Map(tags.map((t) => [t.name, t])), releases: new Map(releases), calls: [] };
  const resp = (status, body = null) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Map(),
  });
  return {
    state,
    async request(method, url) {
      state.calls.push(`${method} ${url}`);
      let m;
      if (method === 'DELETE' && (m = /releases\/(\d+)$/.exec(url))) {
        for (const [tagName, r] of state.releases) {
          if (r.id === Number(m[1])) {
            state.releases.delete(tagName);
            return resp(204);
          }
        }
        return resp(404);
      }
      if (method === 'DELETE' && (m = /git\/refs\/tags\/(.+)$/.exec(url))) {
        const name = decodeURIComponent(m[1]);
        return state.tags.delete(name) ? resp(204) : resp(422, { message: 'Reference does not exist' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
    async json(method, url) {
      state.calls.push(`${method} ${url}`);
      return {
        data: {
          repository: {
            refs: { pageInfo: { hasNextPage: false }, nodes: [...state.tags.values()].map((t) => ({ name: t.name, target: { committedDate: t.date } })) },
          },
        },
      };
    },
    async paginate(url) {
      state.calls.push(`GET ${url}`);
      if (url.includes('/branches')) return branches.map((name) => ({ name }));
      if (url.includes('/releases')) return [...state.releases].map(([tag_name, r]) => ({ tag_name, id: r.id, created_at: r.createdAt }));
      throw new Error(`unexpected GET ${url}`);
    },
  };
}

const fixture = () => ({
  branches: ['main', 'HRZ-5'],
  tags: [tag('v1.0.0'), tag('v1.0.0-hrz-1.1'), tag('v1.0.0-hrz-1.2'), tag('v1.0.0-hrz-5.1'), tag('v1.0.0-hrz-9.1', RECENT)],
  releases: [
    ['v1.0.0-hrz-1.1', { id: 11, createdAt: OLD }],
    ['v1.0.0-hrz-5.1', { id: 51, createdAt: OLD }],
  ],
});

const quiet = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(String(l)), err: () => {} };
};

test('dry run lists the orphans and deletes nothing', async () => {
  const gh = fakeGitHub(fixture());
  const io = quiet();
  const code = await main(['--repo', 'q4mobile/example'], { gh, now: NOW, ...io });
  assert.equal(code, 0);
  assert.equal(gh.state.calls.filter((c) => c.startsWith('DELETE')).length, 0);
  const text = io.lines.join('\n');
  assert.match(text, /v1\.0\.0-hrz-1\.1\t11\t/);
  assert.match(text, /v1\.0\.0-hrz-1\.2\t-\t/);
  assert.doesNotMatch(text, /hrz-5\.1\t|hrz-9\.1\t/);
  assert.match(text, /orphaned tags:\s+2 \(1 with a release\)/);
  assert.match(text, /dry run: nothing deleted/);
});

test('--delete removes orphans, release before tag, and leaves live and recent tags', async () => {
  const gh = fakeGitHub(fixture());
  const code = await main(['--repo', 'q4mobile/example', '--delete', '--delay-ms', '0'], { gh, now: NOW, ...quiet() });
  assert.equal(code, 0);
  assert.deepEqual(gh.state.calls.filter((c) => c.startsWith('DELETE')), [
    'DELETE repos/q4mobile/example/releases/11',
    'DELETE repos/q4mobile/example/git/refs/tags/v1.0.0-hrz-1.1',
    'DELETE repos/q4mobile/example/git/refs/tags/v1.0.0-hrz-1.2',
  ]);
  assert.deepEqual([...gh.state.tags.keys()], ['v1.0.0', 'v1.0.0-hrz-5.1', 'v1.0.0-hrz-9.1']);
  assert.deepEqual([...gh.state.releases.keys()], ['v1.0.0-hrz-5.1']);
});

test('--limit deletes only the oldest N orphans; a second run finishes the rest', async () => {
  const gh = fakeGitHub(fixture());
  await main(['--repo', 'q4mobile/example', '--delete', '--limit', '1', '--delay-ms', '0'], { gh, now: NOW, ...quiet() });
  assert.equal(gh.state.tags.size, 4);
  const code = await main(['--repo', 'q4mobile/example', '--delete', '--delay-ms', '0'], { gh, now: NOW, ...quiet() });
  assert.equal(code, 0);
  assert.equal(gh.state.tags.size, 3);
});

test('resumes without errors when releases and tags were already deleted', async () => {
  const gh = fakeGitHub(fixture());
  // Stale orphan list from an interrupted run: everything in it is already gone.
  const stale = [
    { tag: 'v1.0.0-gone.1', releaseId: 99 },
    { tag: 'v1.0.0-gone.2', releaseId: null },
  ];
  const s = await deleteOrphans(gh, 'q4mobile/example', stale, { delayMs: 0, log: () => {} });
  assert.deepEqual(s, { releasesDeleted: 0, releasesGone: 1, tagsDeleted: 0, tagsGone: 2, failed: 0 });
});

test('keeps the tag when its release cannot be deleted', async () => {
  const gh = fakeGitHub(fixture());
  const request = gh.request;
  gh.request = async (method, url) =>
    url.endsWith('/releases/11') ? { status: 500, ok: false } : request(method, url);
  const s = await deleteOrphans(gh, 'q4mobile/example', [{ tag: 'v1.0.0-hrz-1.1', releaseId: 11 }], { delayMs: 0, log: () => {} });
  assert.equal(s.failed, 1);
  assert.ok(gh.state.tags.has('v1.0.0-hrz-1.1'));
});

test('a tag delete blocked by a ruleset (422) is a failure, not already gone', async () => {
  const gh = fakeGitHub(fixture());
  const request = gh.request;
  gh.request = async (method, url) =>
    url.includes('/git/refs/tags/')
      ? { status: 422, ok: false, text: async () => '{"message":"Repository rule violations found"}' }
      : request(method, url);
  const s = await deleteOrphans(gh, 'q4mobile/example', [{ tag: 'v1.0.0-hrz-1.1', releaseId: 11 }], { delayMs: 0, log: () => {} });
  assert.equal(s.failed, 1);
  assert.equal(s.tagsGone, 0);
});

test('the client waits out a rate limit and retries', async () => {
  const waits = [];
  const responses = [
    { status: 403, ok: false, headers: new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 5)]]), clone() { return this; }, text: async () => '' },
    { status: 429, ok: false, headers: new Map([['retry-after', '2']]), clone() { return this; }, text: async () => '' },
    { status: 403, ok: false, headers: new Map(), clone() { return this; }, text: async () => 'You have exceeded a secondary rate limit' },
    { status: 204, ok: true, headers: new Map() },
  ];
  const gh = createClient({ token: 't', fetchImpl: async () => responses.shift(), sleepImpl: async (ms) => waits.push(ms), log: () => {} });
  const res = await gh.request('DELETE', 'repos/o/r/git/refs/tags/x');
  assert.equal(res.status, 204);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] > 1000 && waits[0] <= 7000);
  assert.equal(waits[1], 3000);
  assert.equal(waits[2], 60000);
});

test('a plain 403 is returned, not retried', async () => {
  let calls = 0;
  const gh = createClient({
    token: 't',
    fetchImpl: async () => (calls++, { status: 403, ok: false, headers: new Map(), clone() { return this; }, text: async () => 'Resource not accessible' }),
    sleepImpl: async () => {},
    log: () => {},
  });
  const res = await gh.request('DELETE', 'repos/o/r/releases/1');
  assert.equal(res.status, 403);
  assert.equal(calls, 1);
});

test('parseArgs requires --repo and validates options', () => {
  assert.throws(() => parseArgs([]), /--repo/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--older-than', '1m']), /days/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--bogus']), /unknown/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--limit', '0']), /--limit/);
  const o = parseArgs(['--repo', 'o/r', '--older-than', '45d']);
  assert.equal(o.olderThanDays, 45);
  assert.equal(o.delete, false);
});
