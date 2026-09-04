const cache = new Map();
const CACHE_MS = 2 * 60_000;

export function parseGitHubRepository(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repository = parts[1].replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null;
    return { owner, repository, slug: `${owner}/${repository}` };
  } catch {
    return null;
  }
}

async function responseJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

export function createGitHubClient(config = {}, fetchImpl = fetch) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cq-review-dashboard",
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

  async function get(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await responseJson(response);
    if (!response.ok) {
      const rateLimited = response.status === 403 || response.status === 429;
      throw new Error(rateLimited
        ? "GitHub activity is temporarily rate limited. Add GITHUB_TOKEN or try again shortly."
        : body.message || `GitHub returned ${response.status}.`);
    }
    return body;
  }

  return {
    async repository(repoUrl) {
      const parsed = parseGitHubRepository(repoUrl);
      if (!parsed) return { available: false, error: "The repository URL is not a supported public GitHub repository.", commits: [] };
      const cached = cache.get(parsed.slug.toLowerCase());
      if (cached && Date.now() - cached.cachedAt < CACHE_MS) return cached.value;
      try {
        const [repository, commits] = await Promise.all([
          get(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`),
          get(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}/commits?per_page=100`),
        ]);
        const value = {
          available: true,
          slug: parsed.slug,
          defaultBranch: repository.default_branch || "",
          description: repository.description || "",
          pushedAt: repository.pushed_at || "",
          updatedAt: repository.updated_at || "",
          openIssues: Number(repository.open_issues_count) || 0,
          stars: Number(repository.stargazers_count) || 0,
          fork: Boolean(repository.fork),
          archived: Boolean(repository.archived),
          license: repository.license?.spdx_id || repository.license?.name || "Not detected",
          commits: (Array.isArray(commits) ? commits : []).map((item) => ({
            sha: String(item.sha || "").slice(0, 7),
            message: String(item.commit?.message || "Untitled commit").split("\n")[0],
            author: item.author?.login || item.commit?.author?.name || "Unknown",
            date: item.commit?.author?.date || item.commit?.committer?.date || "",
            url: item.html_url || "",
            verified: item.commit?.verification?.verified === true,
          })),
        };
        cache.set(parsed.slug.toLowerCase(), { cachedAt: Date.now(), value });
        return value;
      } catch (error) {
        return { available: false, slug: parsed.slug, error: error.message || "Could not load GitHub activity.", commits: [] };
      }
    },
  };
}
