#!/usr/bin/env node
'use strict';

/**
 * One-time cleanup of orphaned semantic-release prerelease tags and their GitHub releases.
 *
 * A tag `vX.Y.Z-<id>.N` is orphaned when no live branch has prerelease id `<id>` and the tag
 * is older than the cutoff. Ids are compared with the rule the action uses (prerelease-id.js)
 * and, to stay on the safe side, also ignoring case and punctuation, so a live branch keeps
 * its tags even if they were created under an older naming rule (`HRZ-1` vs `hrz-1`).
 *
 * Dry run by default. Pass --delete to delete; each orphan's release goes first, then its tag
 * (the same order as the action). Already-deleted releases and tags count as done, so an
 * interrupted run can simply be started again.
 *
 * Usage:
 *   node scripts/cleanup-orphans.js --repo q4mobile/platform-crm-mfe [--older-than 30d]
 *        [--list orphans.tsv] [--delete [--limit N] [--delay-ms 1000]]
 *
 * Auth: GH_TOKEN or GITHUB_TOKEN, else `gh auth token`. Deleting needs contents: write.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prereleaseId } = require(path.join(__dirname, '..', 'prerelease-id.js'));

const TAG_RE = /^v\d+\.\d+\.\d+-(.+)\.\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Lowercase and drop everything but letters and digits: `HRZ-1`, `hrz-1` and `hrz_1` match.
const looseKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Splits tags into orphans and kept ones.
 * @param {object} p
 * @param {string[]} p.branches live branch names
 * @param {{name: string, date: string|null}[]} p.tags every tag, with its commit/tagger date
 * @param {Map<string, {id: number, createdAt: string|null}>} p.releases releases by tag name
 * @param {Date} p.cutoff tags with a date at or after this are kept
 */
function classify({ branches, tags, releases, cutoff }) {
  const exactIds = new Set(branches.map(prereleaseId).filter(Boolean));
  const looseIds = new Set(branches.map(looseKey).filter(Boolean));
  const result = {
    orphans: [],
    kept: { liveBranch: 0, liveBranchLoose: 0, newerThanCutoff: 0, unknownDate: 0 },
    notPrerelease: 0,
  };
  for (const tag of tags) {
    const m = TAG_RE.exec(tag.name);
    if (!m) {
      result.notPrerelease++;
      continue;
    }
    const id = m[1];
    if (exactIds.has(id)) {
      result.kept.liveBranch++;
      continue;
    }
    if (looseIds.has(looseKey(id))) {
      result.kept.liveBranchLoose++;
      continue;
    }
    const release = releases.get(tag.name) || null;
    // Newest known date wins, so a recent release on an old commit keeps the tag.
    const dates = [tag.date, release && release.createdAt].filter(Boolean).map((d) => new Date(d));
    if (dates.length === 0 || dates.some((d) => Number.isNaN(d.getTime()))) {
      result.kept.unknownDate++;
      continue;
    }
    const newest = new Date(Math.max(...dates.map((d) => d.getTime())));
    if (newest >= cutoff) {
      result.kept.newerThanCutoff++;
      continue;
    }
    result.orphans.push({ tag: tag.name, id, date: newest.toISOString(), releaseId: release ? release.id : null });
  }
  result.orphans.sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag));
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal GitHub client: waits out primary and secondary rate limits and retries. */
function createClient({ token, fetchImpl = fetch, log = console.error, sleepImpl = sleep, maxRetries = 8 }) {
  async function request(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.startsWith('http') ? url : `https://api.github.com/${url}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'delete-tag-and-release-cleanup',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const wait = await rateLimitWait(res);
      if (wait !== null && attempt < maxRetries) {
        log(`⏳ rate limited (HTTP ${res.status}); waiting ${Math.ceil(wait / 1000)}s`);
        await sleepImpl(wait);
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries) {
        const backoff = Math.min(60000, 1000 * 2 ** attempt);
        log(`⏳ HTTP ${res.status} for ${method} ${url}; retrying in ${backoff / 1000}s`);
        await sleepImpl(backoff);
        continue;
      }
      return res;
    }
  }

  // Returns ms to wait when the response is a rate-limit rejection, else null.
  async function rateLimitWait(res) {
    if (res.status !== 403 && res.status !== 429) return null;
    const h = (n) => res.headers.get(n);
    if (h('retry-after')) return Number(h('retry-after')) * 1000 + 1000;
    if (h('x-ratelimit-remaining') === '0' && h('x-ratelimit-reset')) {
      return Math.max(0, Number(h('x-ratelimit-reset')) * 1000 - Date.now()) + 1000;
    }
    const text = await res.clone().text().catch(() => '');
    if (/rate limit/i.test(text)) return 60000; // secondary limit without headers
    return null;
  }

  async function json(method, url, body) {
    const res = await request(method, url, body);
    if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function paginate(url) {
    const out = [];
    let next = url;
    while (next) {
      const res = await request('GET', next);
      if (!res.ok) throw new Error(`GET ${next}: HTTP ${res.status} ${await res.text()}`);
      out.push(...(await res.json()));
      const link = res.headers.get('link') || '';
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      next = m ? m[1] : null;
    }
    return out;
  }

  return { request, json, paginate };
}

const TAGS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          ... on Commit { committedDate }
          ... on Tag { tagger { date } target { ... on Commit { committedDate } } }
        }
      }
    }
  }
}`;

async function listTags(gh, repo) {
  const [owner, name] = repo.split('/');
  const tags = [];
  let after = null;
  do {
    const r = await gh.json('POST', 'graphql', { query: TAGS_QUERY, variables: { owner, name, after } });
    if (r.errors) throw new Error(`graphql: ${JSON.stringify(r.errors)}`);
    const refs = r.data.repository.refs;
    for (const n of refs.nodes) {
      const t = n.target || {};
      const date = t.committedDate || (t.tagger && t.tagger.date) || (t.target && t.target.committedDate) || null;
      tags.push({ name: n.name, date });
    }
    after = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (after);
  return tags;
}

async function listReleases(gh, repo) {
  const releases = new Map();
  for (const r of await gh.paginate(`repos/${repo}/releases?per_page=100`)) {
    releases.set(r.tag_name, { id: r.id, createdAt: r.created_at || r.published_at || null });
  }
  return releases;
}

async function listBranches(gh, repo) {
  return (await gh.paginate(`repos/${repo}/branches?per_page=100`)).map((b) => b.name);
}

/**
 * Deletes each orphan's release, then its tag. A 404 (or 422 for a missing ref) means it is
 * already gone. If a release delete fails, its tag is kept so the pair is never split.
 */
async function deleteOrphans(gh, repo, orphans, { delayMs = 1000, log = console.log, sleepImpl = sleep } = {}) {
  const stats = { releasesDeleted: 0, releasesGone: 0, tagsDeleted: 0, tagsGone: 0, failed: 0 };
  for (const [i, o] of orphans.entries()) {
    const prefix = `[${i + 1}/${orphans.length}]`;
    if (o.releaseId !== null) {
      const res = await gh.request('DELETE', `repos/${repo}/releases/${o.releaseId}`);
      if (res.status === 404) stats.releasesGone++;
      else if (res.ok) stats.releasesDeleted++;
      else {
        log(`${prefix} 🌶  failed to delete release for ${o.tag}: HTTP ${res.status}; keeping the tag`);
        stats.failed++;
        continue;
      }
      await sleepImpl(delayMs);
    }
    const res = await gh.request('DELETE', `repos/${repo}/git/refs/tags/${encodeURIComponent(o.tag)}`);
    if (res.status === 404 || res.status === 422) stats.tagsGone++;
    else if (res.ok) {
      stats.tagsDeleted++;
      log(`${prefix} 🗑  deleted ${o.tag}${o.releaseId !== null ? ' and its release' : ''}`);
    } else {
      log(`${prefix} 🌶  failed to delete tag ${o.tag}: HTTP ${res.status}`);
      stats.failed++;
    }
    await sleepImpl(delayMs);
  }
  return stats;
}

function parseArgs(argv) {
  const opts = { olderThanDays: 30, delete: false, limit: Infinity, delayMs: 1000, list: null, repo: null };
  const value = (i, flag) => {
    if (i >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = value(++i, a);
    else if (a === '--older-than') {
      const m = /^(\d+)d$/.exec(value(++i, a));
      if (!m) throw new Error('--older-than takes days, e.g. 30d');
      opts.olderThanDays = Number(m[1]);
    } else if (a === '--delete') opts.delete = true;
    else if (a === '--limit') opts.limit = Number(value(++i, a));
    else if (a === '--delay-ms') opts.delayMs = Number(value(++i, a));
    else if (a === '--list') opts.list = value(++i, a);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.help && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo || '')) throw new Error('--repo <owner>/<name> is required');
  if (!(opts.limit > 0)) throw new Error('--limit must be a positive number');
  if (!(opts.delayMs >= 0)) throw new Error('--delay-ms must be >= 0');
  return opts;
}

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('no token: set GH_TOKEN or log in with `gh auth login`');
  }
}

async function main(argv, { gh, now = new Date(), out = console.log, err = console.error } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim());
    return 0;
  }
  gh = gh || createClient({ token: resolveToken() });
  const cutoff = new Date(now.getTime() - opts.olderThanDays * DAY_MS);

  err(`listing branches, tags and releases of ${opts.repo}…`);
  const [branches, tags, releases] = await Promise.all([
    listBranches(gh, opts.repo),
    listTags(gh, opts.repo),
    listReleases(gh, opts.repo),
  ]);
  const r = classify({ branches, tags, releases, cutoff });
  const withRelease = r.orphans.filter((o) => o.releaseId !== null).length;

  const rows = r.orphans.map((o) => [o.tag, o.releaseId ?? '-', o.date.slice(0, 10), o.id].join('\t'));
  const table = ['tag\trelease_id\tdate\tprerelease_id', ...rows].join('\n') + '\n';
  if (opts.list) fs.writeFileSync(opts.list, table);
  else if (!opts.delete) out(table.trimEnd());

  out(
    [
      `repo:                 ${opts.repo}`,
      `cutoff:               older than ${opts.olderThanDays} days (before ${cutoff.toISOString().slice(0, 10)})`,
      `live branches:        ${branches.length}`,
      `tags:                 ${tags.length} (${r.notPrerelease} not prerelease)`,
      `releases:             ${releases.size}`,
      `kept, live branch:    ${r.kept.liveBranch} exact id, ${r.kept.liveBranchLoose} ignoring case/punctuation`,
      `kept, too recent:     ${r.kept.newerThanCutoff}`,
      `kept, no date:        ${r.kept.unknownDate}`,
      `orphaned tags:        ${r.orphans.length} (${withRelease} with a release)`,
      opts.list ? `list written to:      ${opts.list}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (!opts.delete) {
    out('dry run: nothing deleted. Re-run with --delete to delete these tags and releases.');
    return 0;
  }
  const batch = r.orphans.slice(0, opts.limit);
  out(`deleting ${batch.length} orphaned tag(s)…`);
  const s = await deleteOrphans(gh, opts.repo, batch, { delayMs: opts.delayMs, log: out });
  out(
    `done: ${s.releasesDeleted} releases and ${s.tagsDeleted} tags deleted, ` +
      `${s.releasesGone} releases and ${s.tagsGone} tags already gone, ${s.failed} failed`,
  );
  return s.failed ? 1 : 0;
}

module.exports = { classify, createClient, deleteOrphans, listTags, listReleases, listBranches, parseArgs, main, looseKey };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`🌶  ${e.message}`);
      process.exitCode = 1;
    },
  );
}
