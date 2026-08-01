import { Router } from "express";
import { requireAuth, requireCsrf } from "../auth.js";
import { nowIso, setFlash } from "../utils.js";

export function dashboardRoutes({ store }) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const [allProjects, orders, milestones, journals] = await Promise.all([
      store.list("project"),
      store.list("order"),
      store.list("milestone"),
      store.list("journal"),
    ]);
    const projects = allProjects
      .filter((project) => project.userId === req.user.id && project.status !== "archived")
      .map((project) => {
        const projectMilestones = milestones.filter((item) => item.projectId === project.id);
        return {
          ...project,
          milestonesDone: projectMilestones.filter((item) => item.complete).length,
          milestonesTotal: projectMilestones.length,
          journalMinutes: journals
            .filter((item) => item.projectId === project.id)
            .reduce((sum, item) => sum + item.minutes, 0),
        };
      })
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

  router.get("/profile", (req, res) => {
    res.render("profile", { title: "Your profile", errors: [], values: req.user });
  });

  router.post("/profile", requireCsrf, async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 100);
    const slackId = String(req.body.slack_id || "").trim().toUpperCase().slice(0, 20);
    const errors = [];
    if (name.length < 2) errors.push("Add the name reviewers should see.");
    if (slackId && !/^U[A-Z0-9]{6,}$/.test(slackId)) errors.push("That does not look like a Slack user ID.");
    if (errors.length) {
      return res.status(422).render("profile", {
        title: "Your profile",
        errors,
        values: { ...req.user, name, slackId },
      });
    }
    req.user.name = name;
    req.user.slackId = slackId;
    req.user.updatedAt = nowIso();
    await store.put("user", req.user.id, req.user);
    setFlash(res, "success", "Profile updated.");
    res.redirect("/app/profile");
  });

  return router;
}
