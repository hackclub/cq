import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient, parseGitHubRepository } from "../src/github.js";

test("GitHub repository parsing accepts only an exact HTTPS repository URL", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/hackclub/cq.git"), {
    owner: "hackclub", repository: "cq", slug: "hackclub/cq",
  });
  for (const value of [
    "http://github.com/hackclub/cq", "https://www.github.com/hackclub/cq",
    "https://github.com/hackclub/cq/issues", "https://github.com@evil.example/hackclub/cq",
    "https://github.com/hackclub",
  ]) assert.equal(parseGitHubRepository(value), null);
});

test("GitHub client normalizes repository metadata and commit evidence", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = url.includes("/commits?") ? [{
      sha: "1234567890", html_url: "https://github.com/hackclub/cq/commit/123",
      author: { login: "radio-maker" },
      commit: { message: "Build receiver\n\nDetails", author: { date: "2026-08-31T00:00:00.000Z" }, verification: { verified: true } },
    }] : {
      default_branch: "main", description: "A receiver", pushed_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z", open_issues_count: 1, stargazers_count: 2,
      fork: false, archived: false, license: { spdx_id: "MIT" },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await createGitHubClient({ githubToken: "test-token" }, fetchImpl)
    .repository("https://github.com/hackclub/cq");
  assert.equal(result.available, true);
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.commits[0].message, "Build receiver");
  assert.equal(result.commits[0].sha, "1234567");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
});
