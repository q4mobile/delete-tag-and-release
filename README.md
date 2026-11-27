# GitHub Action: Delete tag and release

Deletes a branch's semantic-release prerelease tags (`vX.Y.Z-<prerelease id>.N`) and their
GitHub releases, typically when the branch is deleted.

```yaml
- uses: q4mobile/delete-tag-and-release@v3.0.0
  with:
    branch_name: ${{ github.event.ref }}
    # branch_name_override: other-branch   # optional: use this branch name instead
    # prerelease_id: my-id                 # optional: see below
  env:
    GH_TOKEN: ${{ secrets.TOKEN_WITH_CONTENTS_WRITE }}
```

## Which tags are deleted

Only tags that match `vX.Y.Z-<prerelease id>.N` exactly, so a branch never deletes another
branch's tags (`fix-abc` does not touch `v1.2.3-fix-abc-2.1`).

By default the prerelease id is computed the same way Q4 repos configure semantic-release:

```json
{ "name": "!main", "prerelease": "${_.lowerCase(name).replace(/[^a-zA-Z0-9]/g, '-')}" }
```

| Branch                 | Prerelease id           |
| ---------------------- | ----------------------- |
| `HRZ-2573-poc-rspack1` | `hrz-2573-poc-rspack-1` |
| `feature/CRMP-88`      | `feature-crmp-88`       |
| `gitStream`            | `git-stream`            |
| `fix--x`               | `fix-x`                 |

Branches that semantic-release maps to the same id (`fix--x`, `fix/x_`, `Fix-X` → `fix-x`)
already share one set of tags, so deleting any of them deletes that shared set.

If a repo names its prereleases differently, pass the id with `prerelease_id`.
`prerelease_id` may only contain `[0-9A-Za-z.-]`.

**Breaking in v3:** v2 searched for the branch name with its case kept and no word splitting
(`HRZ-2573-poc-rspack1`). Before moving a caller to v3, make sure its semantic-release
prerelease rule is `_.lowerCase(name).replace(/[^a-zA-Z0-9]/g, '-')`. Changing the rule is
simpler than passing `prerelease_id`: GitHub expressions cannot lowercase or replace text, so
a caller cannot build a per-branch id without an extra job. Repos that used a different rule
when v3 was written:

| Repo | Prerelease rule | Effect of v3 |
| --- | --- | --- |
| platform-ai-partner-api, platform-q-mcp | `toLowerCase().replace(/[^a-z0-9]/g, '-')` | Better than v2 for uppercase branches; differs for names like `fix-x1` (`fix-x1` vs `fix-x-1`), which can delete a live `fix-x-1` branch's tags |
| capital-connect-mobile (via react-native-workflows) | `name.replace(/[^a-zA-Z0-9]/g, '-')` | Same as v2's formula: v3 finds no tags for uppercase branches, and deleting `HRZ-1` can remove a live `hrz-1` branch's tags |

The computation lives in `prerelease-id.js`, which carries lodash's `lowerCase` (MIT) so the
action needs no `npm install`. It needs `node` on the runner (GitHub-hosted runners have it).

## Cleaning up tags of branches that are already gone

The action only runs when a branch is deleted. Before v3 it missed the tags of many branches
(see above), and those tags and releases are still in the repos. `scripts/cleanup-orphans.js`
removes them in a one-time run:

```bash
# Dry run (default): prints the counts and lists every tag and release it would delete.
node scripts/cleanup-orphans.js --repo q4mobile/platform-crm-mfe --list orphans.tsv

# After the dry run is reviewed: delete. --limit N deletes the oldest N first.
node scripts/cleanup-orphans.js --repo q4mobile/platform-crm-mfe --delete
```

A tag `vX.Y.Z-<id>.N` is orphaned when no live branch has prerelease id `<id>` and the tag
(and its release, if any) is older than `--older-than` (default `30d`). Live branches are
matched with the rule above and also ignoring case and punctuation, so a live branch keeps
tags created under an older naming rule (`HRZ-1` keeps `v1.0.0-HRZ-1.1`).

Deleting removes the release first, then the tag, and waits `--delay-ms` (default 1000)
between calls to stay under GitHub's secondary rate limits; it also waits out rate-limit
responses. A release or tag that is already gone counts as done, so an interrupted run can be
started again. If a release cannot be deleted, its tag is kept.

Needs Node 18+ and a token with `contents: write` (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth
login`). Run it per repo, and only after that repo's callers are on v3 so no new orphans
appear. Repos whose prerelease rule differs from v3's (see the table above) are not covered.

## Development

```bash
npm test
```
