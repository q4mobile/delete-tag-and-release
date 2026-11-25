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

## Development

```bash
npm test
```
