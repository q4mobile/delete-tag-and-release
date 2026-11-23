'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prereleaseId } = require('../prerelease-id');

// Branch -> prerelease id semantic-release gives it.
const cases = [
  ['HRZ-2573-poc-webpack', 'hrz-2573-poc-webpack'], // uppercase (Jira key)
  ['HRZ-2573-poc-rspack1', 'hrz-2573-poc-rspack-1'], // letter next to a digit
  ['CRMP-215-st2', 'crmp-215-st-2'],
  ['gitStream', 'git-stream'], // camelCase
  ['CRMh-64', 'cr-mh-64'], // mixed case in one word
  ['feature/CRMP-88', 'feature-crmp-88'], // slash prefix + uppercase
  ['fix--x', 'fix-x'], // repeated separator
  ['fix/x_', 'fix-x'], // leading / trailing separator
  ["don't-stop", 'dont-stop'], // apostrophe
  ['HRZ-1234_foo.bar', 'hrz-1234-foo-bar'], // underscore / dot + uppercase
  ['fix-abc', 'fix-abc'], // already lowercase
  ['feature/fix--issue__123', 'feature-fix-issue-123'],
  ['HRZ-2573-pocRspack1', 'hrz-2573-poc-rspack-1'],
  ['---', ''], // no words at all
];

for (const [branch, id] of cases) {
  test(`${branch} -> ${id || '(empty)'}`, () => {
    assert.equal(prereleaseId(branch), id);
  });
}
