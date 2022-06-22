#!/usr/bin/env bash

git_branch="andy-test"
declare -a branch_tags=( $( git tag --list "v[0-9].[0-9].[0-9]-${git_branch}.[0-9]") )
for tag in "${branch_tags[@]}"
do
  echo "git push --delete origin ${tag}"
done