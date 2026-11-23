# GitHub Action: Delete tag and release

Deletes a branch's semantic-release prerelease tags (`vX.Y.Z-<prerelease id>.N`) and their
GitHub releases, typically when the branch is deleted.

```yaml
- uses: q4mobile/delete-tag-and-release@v2.1.0
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

If a repo names its prereleases differently, pass the id with `prerelease_id`.
`prerelease_id` may only contain `[0-9A-Za-z.-]`.

The computation lives in `prerelease-id.js`, which carries lodash's `lowerCase` (MIT) so the
action needs no `npm install`. It needs `node` on the runner (GitHub-hosted runners have it).

## Development

```bash
npm test
```
