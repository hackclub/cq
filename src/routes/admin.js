import { Router } from "express";
import { requireAdmin, requireCsrf } from "../auth.js";
import { nowIso, randomId, setFlash } from "../utils.js";

function sortNewest(items) {
  return [...items].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export function adminRoutes({ store, config, ariClient, hackatimeClient, notifier }) {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const [users, projects, orders, submissions, deliveries, products] = await Promise.all([
      store.list("user"), store.list("project"), store.list("order"),
      store.list("submission"), store.list("delivery"), store.list("product"),
    ]);
    res.render("admin/index", {
      title: "Admin dashboard",
      stats: {
        users: users.length,
        activeProjects: projects.filter((item) => !["archived", "approved"].includes(item.status)).length,
        pendingReviews: submissions.filter((item) => !item.decision && !["withdrawn", "error"].includes(item.phase)).length,
        openOrders: orders.filter((item) => !["fulfilled", "cancelled"].includes(item.status)).length,
      },
      recentProjects: sortNewest(projects).slice(0, 8),
      recentOrders: sortNewest(orders).slice(0, 8),
      deliveries: sortNewest(deliveries).slice(0, 8),
      lowStock: products.filter((item) => item.stock <= 10).sort((a, b) => a.stock - b.stock),
      ariConfigured: ariClient.configured(),
      hackatimeConfigured: hackatimeClient.configured(),
      hackatimeRedirectUri: config.hackatimeRedirectUri,
    });
  });

  router.get("/users", async (req, res) => {
    const users = sortNewest(await store.list("user"));
    res.render("admin/users", { title: "Manage users", users });
  });

  router.post("/users/:id", requireCsrf, async (req, res) => {
    const user = await store.get("user", req.params.id);
    if (!user) return res.sendStatus(404);
    const hertzDelta = Number.parseFloat(req.body.hertz_delta || "0");
    if (Number.isFinite(hertzDelta) && hertzDelta !== 0) {
      user.hertz = Math.max(0, Math.round((user.hertz + hertzDelta) * 100) / 100);
    }
    if (["participant", "admin"].includes(req.body.role)) user.role = req.body.role;
    user.updatedAt = nowIso();
    await store.put("user", user.id, user);
    setFlash(res, "success", `${user.name} updated.`);
    res.redirect("/admin/users");
  });

  router.get("/projects", async (req, res) => {
    const [projects, users, submissions] = await Promise.all([
      store.list("project"), store.list("user"), store.list("submission"),
    ]);
    const rows = sortNewest(projects).map((project) => ({
      ...project,
      maker: users.find((user) => user.id === project.userId),
      latestSubmission: sortNewest(submissions.filter((item) => item.projectId === project.id))[0],
    }));
    res.render("admin/projects", { title: "Manage projects", projects: rows });
  });

  router.get("/projects/:id", async (req, res) => {
    const project = await store.get("project", req.params.id);
    if (!project) return res.sendStatus(404);
    const [maker, country, milestones, journals, submissions] = await Promise.all([
      store.get("user", project.userId),
      store.get("country", project.countryCode),
      store.list("milestone"),
      store.list("journal"),
      store.list("submission"),
    ]);
    res.render("admin/project-detail", {
      title: project.title,
      project,
      maker,
      country,
      milestones: milestones.filter((item) => item.projectId === project.id).sort((a, b) => a.sortOrder - b.sortOrder),
      journals: journals.filter((item) => item.projectId === project.id).sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
      submissions: sortNewest(submissions.filter((item) => item.projectId === project.id)),
    });
  });

  router.post("/projects/:id", requireCsrf, async (req, res) => {
    const project = await store.get("project", req.params.id);
    if (!project) return res.sendStatus(404);
    const previousStatus = project.status;
    if (["building", "submitted", "needs_changes", "approved", "rejected", "archived"].includes(req.body.status)) {
      project.status = req.body.status;
    }
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    if (previousStatus !== project.status) {
      const user = await store.get("user", project.userId);
      const event = {
        submitted: "review.requeued",
        needs_changes: "review.changes",
        approved: "review.approved",
        rejected: "review.rejected",
      }[project.status];
      if (user && event) await notifier.projectDecision(user, project, event);
    }
    setFlash(res, "success", `${project.title} updated.`);
    res.redirect("/admin/projects");
  });

  router.get("/orders", async (req, res) => {
    const [orders, users] = await Promise.all([store.list("order"), store.list("user")]);
    const rows = sortNewest(orders).map((order) => ({ ...order, maker: users.find((user) => user.id === order.userId) }));
    res.render("admin/orders", { title: "Manage orders", orders: rows });
  });

  router.post("/orders/:id", requireCsrf, async (req, res) => {
    const existing = await store.get("order", req.params.id);
    if (!existing) return res.sendStatus(404);
    const allowedStatuses = ["received", "packing", "shipped", "fulfilled", "cancelled"];
    const requestedStatus = allowedStatuses.includes(req.body.status) ? req.body.status : existing.status;
    if (existing.status === "cancelled" && requestedStatus !== "cancelled") {
      setFlash(res, "error", "A refunded order cannot be reopened. Create a new order instead.");
      return res.redirect("/admin/orders");
    }
    const previousStatus = existing.status;
    const order = await store.withLock(`order:${existing.id}`, async () => {
      const current = await store.get("order", existing.id);
      const timestamp = nowIso();
      if (requestedStatus === "cancelled" && current.status !== "cancelled" && !current.refundedAt) {
        const user = await store.get("user", current.userId);
        if (user) {
          user.hertz = Math.round((user.hertz + current.total) * 100) / 100;
          user.updatedAt = timestamp;
          await store.put("user", user.id, user);
        }
        for (const item of current.items) {
          const product = await store.get("product", item.productId);
          if (product) {
            product.stock += item.quantity;
            await store.put("product", product.id, product);
          }
        }
        current.refundedAt = timestamp;
      }
      current.status = requestedStatus;
      current.trackingUrl = String(req.body.tracking_url || "").trim().slice(0, 500);
      current.adminNote = String(req.body.admin_note || "").trim().slice(0, 1000);
      current.updatedAt = timestamp;
      await store.put("order", current.id, current);
      return current;
    });
    if (previousStatus !== order.status) {
      const user = await store.get("user", order.userId);
      if (user) await notifier.orderUpdated(user, order);
    }
    setFlash(res, "success", order.status === "cancelled" ? `Order ${order.id} cancelled and refunded.` : `Order ${order.id} updated.`);
    res.redirect("/admin/orders");
  });

  router.get("/shop", async (req, res) => {
    const products = (await store.list("product")).sort((a, b) => a.sortOrder - b.sortOrder);
    res.render("admin/shop", { title: "Manage shop", products });
  });

  router.post("/shop", requireCsrf, async (req, res) => {
    const id = randomId("product_");
    const product = productInput(req.body, id);
    await store.put("product", id, product);
    setFlash(res, "success", `${product.name} added to the shop.`);
    res.redirect("/admin/shop");
  });

  router.post("/shop/:id", requireCsrf, async (req, res) => {
    const existing = await store.get("product", req.params.id);
    if (!existing) return res.sendStatus(404);
    await store.put("product", existing.id, { ...existing, ...productInput(req.body, existing.id) });
    setFlash(res, "success", `${req.body.name} updated.`);
    res.redirect("/admin/shop");
  });

  router.get("/reviews", async (req, res) => {
    const [submissions, projects, deliveries] = await Promise.all([
      store.list("submission"), store.list("project"), store.list("delivery"),
    ]);
    const rows = sortNewest(submissions).map((submission) => ({
      ...submission,
      project: projects.find((project) => project.id === submission.projectId),
    }));
    res.render("admin/reviews", {
      title: "Ari reviews and webhooks",
      submissions: rows,
      deliveries: sortNewest(deliveries),
      ariConfigured: ariClient.configured(),
    });
  });

  router.get("/countries", async (req, res) => {
    const countries = (await store.list("country")).sort((a, b) => a.sortOrder - b.sortOrder);
    res.render("admin/countries", { title: "Country policies", countries });
  });

  router.get("/notifications", async (req, res) => {
    const notifications = sortNewest(await store.list("notification"));
    res.render("admin/notifications", {
      title: "Slack notifications",
      notifications,
      slackConfigured: notifier.configured(),
    });
  });

  router.post("/countries", requireCsrf, async (req, res) => {
    const code = String(req.body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
    if (!code || !String(req.body.name || "").trim()) {
      setFlash(res, "error", "Country code and name are required.");
      return res.redirect("/admin/countries");
    }
    await store.put("country", code, countryInput(req.body, code));
    setFlash(res, "success", `${req.body.name} added.`);
    res.redirect("/admin/countries");
  });

  router.post("/countries/:id", requireCsrf, async (req, res) => {
    const existing = await store.get("country", req.params.id);
    if (!existing) return res.sendStatus(404);
    await store.put("country", existing.id, countryInput(req.body, existing.id));
    setFlash(res, "success", `${req.body.name} policy updated.`);
    res.redirect("/admin/countries");
  });

  return router;
}

function productInput(body, id) {
  return {
    id,
    name: String(body.name || "").trim().slice(0, 120),
    description: String(body.description || "").trim().slice(0, 1000),
    price: Math.max(0, Number.parseInt(body.price || "0", 10) || 0),
    stock: Math.max(0, Number.parseInt(body.stock || "0", 10) || 0),
    image: String(body.image || "").trim().slice(0, 500),
    category: String(body.category || "gear").trim().slice(0, 80),
    sortOrder: Number.parseInt(body.sort_order || "100", 10) || 100,
    active: body.active === "1",
  };
}

function countryInput(body, id) {
  const fulfilmentModes = ["local", "standard", "customs", "restricted", "manual_review"];
  return {
    id,
    code: id,
    name: String(body.name || "").trim().slice(0, 120),
    ownershipRule: String(body.ownership_rule || "").trim().slice(0, 1200),
    transmissionRule: String(body.transmission_rule || "").trim().slice(0, 1200),
    fulfilmentMode: fulfilmentModes.includes(body.fulfilment_mode) ? body.fulfilment_mode : "manual_review",
    fulfilmentNote: String(body.fulfilment_note || "").trim().slice(0, 1200),
    sourceUrl: String(body.source_url || "").trim().slice(0, 500),
    sortOrder: Number.parseInt(body.sort_order || "100", 10) || 100,
    active: body.active === "1",
    updatedAt: nowIso(),
  };
}
