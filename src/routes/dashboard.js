import { Router } from "express";
import { requireAuth } from "../auth.js";

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
    });
  });

  return router;
}
