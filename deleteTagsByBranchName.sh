#!/usr/bin/env bash
git_branch=${INPUT_BRANCH_NAME:-$GITHUB_REF_NAME}
tag_format=${git_branch//[^a-zA-Z0-9]/-}
echo $tag_format
git fetch --all --tags
#search patten vX.X.X-branchName-x
declare -a tags=( $( git tag --list "v[0-9].[0-9].[0-9]-${tag_format}.[0-9]*") )
for tag_name in "${tags[@]}"
do
  node index.js ${tag_name}
  echo "git push --delete origin ${tag_name}"
  git push --delete origin ${tag_name}
done