import { Router } from "express";
import { requireAuth, requireCsrf } from "../auth.js";
import crypto from "node:crypto";
import { hash, nowIso, randomId, setFlash } from "../utils.js";

export function dashboardRoutes({ store, hackatimeClient }) {
  const router = Router();
  router.use(requireAuth);

  async function renderDashboard(req, res) {
    const [allProjects, orders, journals] = await Promise.all([
      store.list("project"),
      store.list("order"),
      store.list("journal"),
    ]);
    const projects = allProjects
      .filter((project) => project.userId === req.user.id && project.status !== "archived")
      .map((project) => ({
        ...project,
        journalMinutes: journals
          .filter((item) => item.projectId === project.id)
          .reduce((sum, item) => sum + item.minutes, 0),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latestOrder = orders
      .filter((order) => order.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    res.render("dashboard", {
      title: "Your CQ dashboard",
      projects: projects.slice(0, 4),
      latestOrder,
      stats: {
        projectCount: projects.length,
        approvedCount: projects.filter((project) => project.status === "approved").length,
      },
    });
  }

  function publicProject(project, maker) {
    return {
      id: project.id,
      title: project.title,
      description: project.description,
      track: project.track,
      tags: Array.isArray(project.tags) ? project.tags : [],
      thumbnailUrl: project.thumbnailUrl,
      demoUrl: project.demoUrl,
      repoUrl: project.repoUrl,
      radioRelevance: project.radioRelevance,
      updatedAt: project.updatedAt,
      approvedAt: project.approvedAt || project.updatedAt,
      makerName: maker?.name || "CQ maker",
    };
  }

  async function exploreProjects(query = {}) {
    const [projects, users, submissions] = await Promise.all([store.list("project"), store.list("user"), store.list("submission")]);
    const makerById = new Map(users.map((user) => [user.id, user]));
    const search = String(query.q || "").trim().toLowerCase().slice(0, 80);
    const track = ["hardware", "software"].includes(query.track) ? query.track : "";
    const sort = query.sort === "recent" ? "recent" : "approved";
    const rows = projects
      .filter((project) => project.id !== "cq_reviewer_training" && project.status === "approved" && project.visibility === "public")
      .filter((project) => !track || project.track === track)
      .filter((project) => !search || [project.title, project.description, ...(project.tags || [])].join(" ").toLowerCase().includes(search))
      .map((project) => {
        const approved = submissions
          .filter((submission) => submission.projectId === project.id && submission.decision === "approved" && submission.projectSnapshot)
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
        return publicProject(approved ? { ...approved.projectSnapshot, approvedAt: approved.updatedAt } : project, makerById.get(project.userId));
      });
    rows.sort((a, b) => String(sort === "recent" ? b.updatedAt : b.approvedAt).localeCompare(String(sort === "recent" ? a.updatedAt : a.approvedAt)));
    return rows;
  }

  router.get("/", async (req, res) => {
    const projects = await exploreProjects(req.query);
    res.render("explore", {
      title: "Explore projects",
      projects,
      filters: { q: String(req.query.q || "").slice(0, 80), track: ["hardware", "software"].includes(req.query.track) ? req.query.track : "", sort: req.query.sort === "recent" ? "recent" : "approved" },
    });
  });

  router.get("/dashboard", renderDashboard);

  router.get("/explore", (req, res) => {
    const query = new URLSearchParams(req.query).toString();
    res.redirect(`/app${query ? `?${query}` : ""}`);
  });

  router.get("/explore/:id", async (req, res) => {
    const project = await store.get("project", req.params.id);
    if (!project || project.id === "cq_reviewer_training" || project.status !== "approved" || project.visibility !== "public") return res.sendStatus(404);
    const [maker, submissions] = await Promise.all([store.get("user", project.userId), store.list("submission")]);
    const approved = submissions
      .filter((submission) => submission.projectId === project.id && submission.decision === "approved" && submission.projectSnapshot)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const visibleProject = approved ? { ...approved.projectSnapshot, approvedAt: approved.updatedAt } : project;
    res.render("explore-detail", { title: visibleProject.title, project: publicProject(visibleProject, maker) });
  });

  router.get("/profile", async (req, res) => {
    res.render("profile", {
      title: "Your profile",
      errors: [],
      values: req.user,
      hackatime: await hackatimeClient.connection(req.user.id),
      mcpTokens: (await store.list("mcp_token")).filter((token) => token.userId === req.user.id && !token.revokedAt),
    });
  });

  router.post("/profile/mcp-token", requireCsrf, async (req, res) => {
    const raw = `cq_mcp_${crypto.randomBytes(32).toString("base64url")}`;
    const id = randomId("mcp_");
    await store.put("mcp_token", id, { id, userId: req.user.id, tokenHash: hash(raw), scopes: ["read"], createdAt: nowIso(), lastUsedAt: null });
    res.locals.mcpToken = raw;
    setFlash(res, "success", `MCP token created. Copy it now; it will not be shown again.`);
    return res.render("profile", { title: "Your profile", errors: [], values: req.user, hackatime: await hackatimeClient.connection(req.user.id), mcpTokens: (await store.list("mcp_token")).filter((token) => token.userId === req.user.id && !token.revokedAt), oneTimeMcpToken: raw });
  });

  return router;
}
