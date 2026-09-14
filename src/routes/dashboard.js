import { Router } from "express";
import { requireAuth, requireCsrf } from "../auth.js";
import crypto from "node:crypto";
import { hash, nowIso, randomId, setFlash } from "../utils.js";

export function dashboardRoutes({ store, hackatimeClient }) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
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

  router.post("/profile/mcp-token/:id/revoke", requireCsrf, async (req, res) => {
    const token = await store.get("mcp_token", req.params.id);
    if (!token || token.userId !== req.user.id || token.revokedAt) return res.sendStatus(404);
    await store.put("mcp_token", token.id, { ...token, revokedAt: nowIso() });
    setFlash(res, "success", "MCP token revoked.");
    res.redirect("/app/profile");
  });

  return router;
}
