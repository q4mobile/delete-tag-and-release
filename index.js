const fetch = require("./fetch");

const arguments = process.argv.slice(2);
console.log(arguments)
tagName = arguments[0]

if (!process.env.GITHUB_TOKEN) {
  console.error("🔴 no GITHUB_TOKEN found. pass `GITHUB_TOKEN` as env");
  process.exitCode = 1;
  return;
}
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let owner, repo;

if (process.env.GITHUB_REPOSITORY) {
  [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
} else {
  console.error("🔴 no GITHUB_REPOSITORY found. pass `GITHUB_REPOSITORY` as env");
  process.exitCode = 1;
  return;
}
console.log(`📕  given repo is "${owner}/${repo}"`);

const commonOpts = {
  host: "api.github.com",
  port: 443,
  protocol: "https:",
  auth: `user:${GITHUB_TOKEN}`,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "node.js",
  },
};

console.log(`🏷  given tag is "${tagName}"`);

async function deleteReleases() {
  let releaseIds = [];
  try {
    const data = await fetch({
      ...commonOpts,
      path: `/repos/${owner}/${repo}/releases`,
      method: "GET",
    });
    releaseIds = (data || [])
      .filter(({ tag_name, draft }) => tag_name === tagName && draft === false)
      .map(({ id }) => id);
  } catch (error) {
    console.error(`🌶  failed to get list of releases <- ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (releaseIds.length === 0) {
    console.error(`😕  no releases found associated to tag "${tagName}"`);
    return;
  }
  console.log(`🍻  found ${releaseIds.length} releases to delete`);

  let hasError = false;
  for (let i = 0; i < releaseIds.length; i++) {
    const releaseId = releaseIds[i];

    try {
      const _ = await fetch({
        ...commonOpts,
        path: `/repos/${owner}/${repo}/releases/${releaseId}`,
        method: "DELETE",
      });
    } catch (error) {
      console.error(`🌶  failed to delete release with id "${releaseId}"  <- ${error.message}`);
      hasError = true;
      break;
    }
  }

  if (hasError) {
    process.exitCode = 1;
    return;
  }

  console.log(`👍🏼  all releases deleted successfully!`);
}

async function run() {
   await deleteReleases();
}
run();
