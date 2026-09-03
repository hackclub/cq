import { Router } from "express";
import multer from "multer";
import { hasPermission, requireOrganizer, requirePermission, requireCsrf, roleDefinitions, userRoles } from "../auth.js";
import { writeAudit } from "../audit.js";
import { nowIso, randomId, setFlash } from "../utils.js";

function sortNewest(items) {
  return [...items].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function sessionIsActive(session) {
  return !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now();
}

async function revokeSessions(store, sessions, actor) {
  const revokedAt = nowIso();
  for (const session of sessions.filter(sessionIsActive)) {
    await store.put("session", session.id, {
      ...session,
      revokedAt,
      revokedBy: actor.id,
    });
  }
  return sessions.filter(sessionIsActive).length;
}

function journalsForReview(submission, journals) {
  if (Array.isArray(submission.journalSnapshots)) return structuredClone(submission.journalSnapshots);
  const projectJournals = journals.filter((item) => item.projectId === submission.projectId);
  if (submission.journalIds?.length) {
    const included = new Set(submission.journalIds);
    return projectJournals.filter((item) => included.has(item.id));
  }
  return projectJournals.filter((item) => !submission.createdAt || String(item.createdAt || "") <= submission.createdAt);
}

function reviewMinutes(journals) {
  return Math.round(journals.reduce((sum, item) => sum + Math.max(0, Number(item.minutes) || 0), 0));
}

function projectForReview(submission, currentProject) {
  if (submission.projectSnapshot) return structuredClone(submission.projectSnapshot);
  const payload = submission.payload || {};
  return {
    ...currentProject,
    title: payload.title || currentProject.title,
    description: payload.description || currentProject.description,
    repoUrl: payload.repo_url || currentProject.repoUrl,
    demoUrl: payload.demo_url || currentProject.demoUrl,
    thumbnailUrl: payload.thumbnail_url || currentProject.thumbnailUrl,
    track: payload.track || currentProject.track,
    projectType: payload.meta?.["Project type"] || currentProject.projectType,
    radioRelevance: payload.meta?.["Ham radio relevance"] || currentProject.radioRelevance,
    hackatimeProjects: payload.hackatime_projects || currentProject.hackatimeProjects || [],
    aiStatement: payload.meta?.["AI statement"] || currentProject.aiStatement,
  };
}

export function adminRoutes({ store, config, ariClient, githubClient, cdnClient, notifier }) {
  const router = Router();
  router.use(requireOrganizer);
  router.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    res.once('finish', () => {
      const outcome = res.statusCode >= 200 && res.statusCode < 400 ? "completed" : `failed with HTTP ${res.statusCode}`;
      req.app.locals.logger.info(`${req.user.id} ${outcome} admin action: ${req.method} ${req.originalUrl}`);
      notifier.securityAlert?.(req.user, { method: req.method, path: req.originalUrl, status: res.statusCode }).catch(() => {});
    });
    next();
  });
  const productImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)),
  });

  router.post("/uploads/images", requirePermission("shop.manage"), productImageUpload.single("image"), requireCsrf, async (req, res) => {
    if (!req.file) return res.status(422).json({ error: "Choose a JPG, PNG, WebP, or GIF image." });
    try {
      const image = await uploadProductImage(cdnClient, req.file);
      return res.json({ image });
    } catch (error) {
      return res.status(503).json({ error: error.message || "The image upload failed." });
    }
  });

  router.get("/", async (req, res) => {
    const canUsers = hasPermission(req.user, "users.manage");
    const canReview = hasPermission(req.user, "projects.review");
    const canOrders = hasPermission(req.user, "orders.manage");
    const canShop = hasPermission(req.user, "shop.manage");
    const [users, projects, orders, submissions, deliveries, products, fundingRequests] = await Promise.all([
      canUsers ? store.list("user") : [], canReview ? store.list("project") : [], canOrders ? store.list("order") : [],
      canReview ? store.list("submission") : [], canUsers ? store.list("delivery") : [], canShop ? store.list("product") : [],
      canReview ? store.list("funding_request") : [],
    ]);
    res.render("admin/index", {
      title: "Admin dashboard",
      stats: {
        users: users.length,
        activeProjects: projects.filter((item) => !["archived", "approved"].includes(item.status)).length,
        pendingReviews: submissions.filter((item) => !item.decision && !["withdrawn", "error"].includes(item.phase)).length,
        pendingFunding: fundingRequests.filter((item) => ["submitted", "under_review", "second_pass"].includes(item.status)).length,
        openOrders: orders.filter((item) => !["fulfilled", "cancelled"].includes(item.status)).length,
      },
      recentProjects: sortNewest(projects).slice(0, 8),
      recentOrders: sortNewest(orders).slice(0, 8),
      deliveries: sortNewest(deliveries).slice(0, 8),
      lowStock: products.filter((item) => item.stock <= 10).sort((a, b) => a.stock - b.stock),
      reviewMode: ariClient.configured() ? "Ari sync + local review" : "Local review",
    });
  });

  router.get("/funding", requirePermission("projects.review"), async (req, res) => {
    const [requests, projects, users] = await Promise.all([store.list("funding_request"), store.list("project"), store.list("user")]);
    const rows = sortNewest(requests).map((request) => ({
      ...request,
      project: projects.find((project) => project.id === request.projectId),
      maker: users.find((user) => user.id === request.userId),
      reviewer: users.find((user) => user.id === request.reviewerId),
    }));
    res.render("admin/funding", { title: "Hardware funding", requests: rows });
  });

  router.get("/funding/:id", requirePermission("projects.review"), async (req, res) => {
    const request = await store.get("funding_request", req.params.id);
    if (!request) return res.sendStatus(404);
    const [project, maker, actions] = await Promise.all([
      store.get("project", request.projectId), store.get("user", request.userId), store.list("review_action"),
    ]);
    res.render("admin/funding-detail", { title: "Hardware funding review", request, project, maker, actions: sortNewest(actions.filter((item) => item.fundingRequestId === request.id)) });
  });

  router.post("/funding/:id/decision", requirePermission("projects.review"), requireCsrf, async (req, res) => {
    const request = await store.get("funding_request", req.params.id);
    if (!request) return res.sendStatus(404);
    if (!['submitted', 'under_review', 'changes_requested'].includes(request.status)) {
      setFlash(res, "error", "This funding request already has a final decision.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const decision = ["approved", "changes", "rejected"].includes(req.body.decision) ? req.body.decision : "";
    const noteToMaker = String(req.body.note_to_maker || "").trim().slice(0, 3000);
    const internalNote = String(req.body.internal_note || "").trim().slice(0, 3000);
    const designChecked = req.body.design_checked === "1";
    const bomChecked = req.body.bom_checked === "1";
    const planChecked = req.body.plan_checked === "1";
    const requested = Math.max(0, Number(request.requestedHertz) || 0);
    const approvedHertz = Math.min(requested, Math.max(0, Math.round((Number(req.body.approved_hertz) || 0) * 100) / 100));
    if (!decision || (["changes", "rejected"].includes(decision) && noteToMaker.length < 5)) {
      setFlash(res, "error", "Choose a decision and give useful feedback when returning or declining a request.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    if (decision === "approved" && (!designChecked || !bomChecked || !planChecked || approvedHertz <= 0)) {
      setFlash(res, "error", "Check the design, BOM, and plan, then enter the approved funding amount.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const before = structuredClone(request);
    const project = await store.get("project", request.projectId);
    const maker = await store.get("user", request.userId);
    const timestamp = nowIso();
    request.status = "second_pass";
    request.reviewerId = req.user.id; request.reviewerName = req.user.name;
    request.firstPass = { decision, noteToMaker, internalNote, approvedHertz: decision === "approved" ? approvedHertz : 0, criteria: { designChecked, bomChecked, planChecked }, reviewerId: req.user.id, reviewerName: req.user.name, reviewedAt: timestamp };
    request.updatedAt = timestamp;
    await store.put("funding_request", request.id, request);
    await addReviewAction(store, { id: request.id, projectId: request.projectId }, req.user, "funding_first_pass", { fundingRequestId: request.id, decision, noteToMaker, internalNote, approvedHertz });
    await writeAudit(store, req.user, { action: "funding.first_pass", entityType: "funding_request", entityId: request.id, summary: `Completed first pass for hardware funding for ${project?.title || request.projectId}.`, before, after: request, metadata: { decision, approvedHertz } });
    setFlash(res, "success", "First pass saved. A second-pass reviewer must confirm it before the maker is notified.");
    res.redirect(`/admin/funding/${request.id}`);
  });

  router.post("/funding/:id/second-pass", requirePermission("reviews.second_pass"), requireCsrf, async (req, res) => {
    const request = await store.get("funding_request", req.params.id);
    if (!request) return res.sendStatus(404);
    if (request.status !== "second_pass" || !request.firstPass) {
      setFlash(res, "error", "This funding request is not waiting for second pass.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    if (request.firstPass.reviewerId === req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "A different organizer must complete second pass.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const decision = ["approved", "changes", "rejected"].includes(req.body.decision) ? req.body.decision : request.firstPass.decision;
    const noteToMaker = String(req.body.note_to_maker || request.firstPass.noteToMaker || "").trim().slice(0, 3000);
    const internalNote = String(req.body.internal_note || "").trim().slice(0, 3000);
    if (["changes", "rejected"].includes(decision) && noteToMaker.length < 5) {
      setFlash(res, "error", "Include useful participant feedback when returning or declining a request.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const approvedHertz = decision === "approved" ? Math.min(Math.max(0, Number(request.requestedHertz) || 0), Math.max(0, Math.round((Number(req.body.approved_hertz ?? request.firstPass.approvedHertz) || 0) * 100) / 100)) : 0;
    if (decision === "approved" && approvedHertz <= 0) {
      setFlash(res, "error", "Enter the approved funding amount.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const before = structuredClone(request); const timestamp = nowIso();
    const [project, maker] = await Promise.all([store.get("project", request.projectId), store.get("user", request.userId)]);
    request.status = { approved: "approved", changes: "changes_requested", rejected: "rejected" }[decision];
    request.review = { decision, noteToMaker, internalNote, approvedHertz, criteria: request.firstPass.criteria, firstPass: request.firstPass, secondPass: { reviewerId: req.user.id, reviewerName: req.user.name, reviewedAt: timestamp, note: internalNote } };
    request.secondPass = request.review.secondPass; request.updatedAt = timestamp;
    await store.put("funding_request", request.id, request);
    if (project) await store.put("project", project.id, { ...project, status: { approved: "funding_approved", changes: "funding_changes", rejected: "funding_rejected" }[decision], updatedAt: timestamp });
    await addReviewAction(store, { id: request.id, projectId: request.projectId }, req.user, `funding_second_pass_${decision}`, { fundingRequestId: request.id, noteToMaker, internalNote, approvedHertz });
    await writeAudit(store, req.user, { action: `funding.second_pass.${decision}`, entityType: "funding_request", entityId: request.id, summary: `Completed second pass for hardware funding for ${project?.title || request.projectId}.`, before, after: request, metadata: { decision, approvedHertz } });
    if (maker && project) await notifier.fundingDecision?.(maker, project, request);
    setFlash(res, "success", "Second pass confirmed and the participant was notified.");
    res.redirect(`/admin/funding/${request.id}`);
  });

  router.post("/funding/:id/issue", requirePermission("projects.review"), requireCsrf, async (req, res) => {
    const request = await store.get("funding_request", req.params.id);
    if (!request) return res.sendStatus(404);
    if (request.status !== "approved") {
      setFlash(res, "error", "Only an approved funding request can be marked issued.");
      return res.redirect(`/admin/funding/${request.id}`);
    }
    const timestamp = nowIso(); const project = await store.get("project", request.projectId); const maker = await store.get("user", request.userId);
    const before = structuredClone(request);
    request.status = "issued"; request.issuedAt = timestamp; request.issuedById = req.user.id;
    request.hcbGrantReference = String(req.body.hcb_grant_reference || "").trim().slice(0, 200); request.updatedAt = timestamp;
    await store.put("funding_request", request.id, request);
    if (project) await store.put("project", project.id, { ...project, status: "funding_issued", updatedAt: timestamp });
    await writeAudit(store, req.user, { action: "funding.issued", entityType: "funding_request", entityId: request.id, summary: `Marked funding issued for ${project?.title || request.projectId}.`, before, after: request });
    if (maker && project) await notifier.fundingIssued?.(maker, project, request);
    setFlash(res, "success", "Funding marked issued. The maker can now build and ship the finished project.");
    res.redirect(`/admin/funding/${request.id}`);
  });

  router.get("/users", requirePermission("users.manage"), async (req, res) => {
    const [storedUsers, sessions] = await Promise.all([store.list("user"), store.list("session")]);
    const users = sortNewest(storedUsers)
      .map((item) => ({
        ...item,
        roleKeys: userRoles(item),
        activeSessionCount: sessions.filter((session) => session.userId === item.id && sessionIsActive(session)).length,
      }));
    res.render("admin/users", { title: "Manage users", users, roleDefinitions });
  });

  router.post("/users/sessions/revoke-all", requirePermission("users.manage"), requireCsrf, async (req, res) => {
    const count = await revokeSessions(store, await store.list("session"), req.user);
    await writeAudit(store, req.user, {
      action: "sessions.revoked_all", entityType: "session", entityId: "all",
      summary: `Signed everyone out of CQ (${count} active session${count === 1 ? "" : "s"}).`,
      metadata: { count },
    });
    setFlash(res, "success", `Signed everyone out of CQ. ${count} session${count === 1 ? "" : "s"} will require Hack Club Auth again.`);
    res.redirect("/admin/users");
  });

  router.post("/users/:id/sessions/revoke", requirePermission("users.manage"), requireCsrf, async (req, res) => {
    const user = await store.get("user", req.params.id);
    if (!user) return res.sendStatus(404);
    const sessions = (await store.list("session")).filter((session) => session.userId === user.id);
    const count = await revokeSessions(store, sessions, req.user);
    await writeAudit(store, req.user, {
      action: "user.sessions_revoked", entityType: "user", entityId: user.id,
      summary: `Signed ${user.name} out of CQ (${count} active session${count === 1 ? "" : "s"}).`,
      metadata: { count },
    });
    setFlash(res, "success", `${user.name} will need to sign in with Hack Club Auth again.`);
    res.redirect("/admin/users");
  });

  router.post("/users/:id", requirePermission("users.manage"), requireCsrf, async (req, res) => {
    const user = await store.get("user", req.params.id);
    if (!user) return res.sendStatus(404);
    const before = structuredClone(user);
    const hertzDelta = Number.parseFloat(req.body.hertz_delta || "0");
    if (Number.isFinite(hertzDelta) && hertzDelta !== 0) {
      user.hertz = Math.max(0, Math.round((user.hertz + hertzDelta) * 100) / 100);
    }
    const selected = Array.isArray(req.body.roles) ? req.body.roles : [req.body.roles].filter(Boolean);
    let roles = [...new Set(["participant", ...selected.filter((role) => roleDefinitions[role])])];
    if (config.adminEmails.includes(user.email)) roles = [...new Set([...roles, "admin"])];
    if (user.id === req.user.id && userRoles(req.user).includes("admin")) roles = [...new Set([...roles, "admin"])];
    user.roles = roles;
    user.role = roles.includes("admin") ? "admin" : "participant";
    user.updatedAt = nowIso();
    await store.put("user", user.id, user);
    const beforeRoles = new Set(userRoles(before));
    const afterRoles = new Set(userRoles(user));
    const addedRoles = [...afterRoles].filter((role) => !beforeRoles.has(role));
    const removedRoles = [...beforeRoles].filter((role) => !afterRoles.has(role));
    const changes = [
      ...addedRoles.map((role) => `added permission: ${role}`),
      ...removedRoles.map((role) => `removed permission: ${role}`),
      ...(Number.isFinite(hertzDelta) && hertzDelta !== 0 ? [`adjusted hertz by ${hertzDelta}`] : []),
    ];
    req.app.locals.logger.info(`${req.user.id} changed permissions of ${user.id}${changes.length ? ` - ${changes.join("; ")}` : " - no effective change"}`);
    await writeAudit(store, req.user, {
      action: "user.updated", entityType: "user", entityId: user.id,
      summary: `Updated roles or hertz for ${user.name}.`, before, after: user,
      metadata: { hertzDelta: Number.isFinite(hertzDelta) ? hertzDelta : 0 },
    });
    setFlash(res, "success", `${user.name} updated.`);
    res.redirect("/admin/users");
  });

  router.get("/projects", requirePermission("projects.review"), async (req, res) => {
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

  router.get("/projects/:id", requirePermission("projects.review"), async (req, res) => {
    const project = await store.get("project", req.params.id);
    if (!project) return res.sendStatus(404);
    const [maker, country, journals, submissions] = await Promise.all([
      store.get("user", project.userId),
      store.get("country", project.countryCode),
      store.list("journal"),
      store.list("submission"),
    ]);
    res.render("admin/project-detail", {
      title: project.title,
      project,
      maker,
      country,
      journals: journals.filter((item) => item.projectId === project.id).sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
      submissions: sortNewest(submissions.filter((item) => item.projectId === project.id)),
    });
  });

  router.post("/projects/:id", requirePermission("projects.review"), requireCsrf, async (req, res) => {
    const project = await store.get("project", req.params.id);
    if (!project) return res.sendStatus(404);
    const before = structuredClone(project);
    const previousStatus = project.status;
    if (["building", "submitted", "archived"].includes(req.body.status)) {
      project.status = req.body.status;
    }
    if (previousStatus === "rejected" && project.status === "building") {
      project.isUpdate = true;
      project.updateMessage = project.updateMessage || "Reopened after review feedback.";
    }
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    await writeAudit(store, req.user, {
      action: "project.status_updated", entityType: "project", entityId: project.id,
      summary: `Changed ${project.title} from ${previousStatus} to ${project.status}.`, before, after: project,
    });
    if (previousStatus !== project.status) {
      const user = await store.get("user", project.userId);
      const event = { submitted: "review.requeued", building: previousStatus === "rejected" ? "review.reopened" : null }[project.status];
      if (user && event) await notifier.projectDecision(user, project, event);
    }
    setFlash(res, "success", `${project.title} updated.`);
    res.redirect("/admin/projects");
  });

  router.get("/orders", requirePermission("orders.manage"), async (req, res) => {
    const [orders, users] = await Promise.all([store.list("order"), store.list("user")]);
    const rows = sortNewest(orders).map((order) => ({ ...order, maker: users.find((user) => user.id === order.userId) }));
    res.render("admin/orders", { title: "Manage orders", orders: rows });
  });

  router.post("/orders/:id", requirePermission("orders.manage"), requireCsrf, async (req, res) => {
    const existing = await store.get("order", req.params.id);
    if (!existing) return res.sendStatus(404);
    const before = structuredClone(existing);
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
      if (requestedStatus === "fulfilled" && previousStatus !== "fulfilled") {
        current.fulfilledById = req.user.id;
        current.fulfilledByName = req.user.name;
        current.fulfilledAt = timestamp;
      }
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
    await writeAudit(store, req.user, {
      action: order.status === "cancelled" ? "order.cancelled" : "order.updated",
      entityType: "order", entityId: order.id,
      summary: `Updated order ${order.id} from ${previousStatus} to ${order.status}.`, before, after: order,
      metadata: { refunded: Boolean(order.refundedAt && !before.refundedAt) },
    });
    setFlash(res, "success", order.status === "cancelled" ? `Order ${order.id} cancelled and refunded.` : `Order ${order.id} updated.`);
    res.redirect("/admin/orders");
  });

  router.get("/shop", requirePermission("shop.manage"), async (req, res) => {
    const products = (await store.list("product")).sort((a, b) => a.sortOrder - b.sortOrder);
    res.render("admin/shop", { title: "Manage shop", products, imageUploadsConfigured: Boolean(cdnClient?.configured()) });
  });

  router.post("/shop", requirePermission("shop.manage"), requireCsrf, async (req, res) => {
    const id = randomId("product_");
    const product = productInput(req.body, id);
    await store.put("product", id, product);
    await writeAudit(store, req.user, {
      action: "product.created", entityType: "product", entityId: product.id,
      summary: `Added ${product.name} to the shop.`, after: product,
    });
    setFlash(res, "success", `${product.name} added to the shop.`);
    res.redirect("/admin/shop");
  });

  router.post("/shop/:id", requirePermission("shop.manage"), requireCsrf, async (req, res) => {
    const existing = await store.get("product", req.params.id);
    if (!existing) return res.sendStatus(404);
    const updated = { ...existing, ...productInput(req.body, existing.id, { image: req.body.image || existing.image }) };
    await store.put("product", existing.id, updated);
    await writeAudit(store, req.user, {
      action: "product.updated", entityType: "product", entityId: updated.id,
      summary: `Updated shop item ${updated.name}.`, before: existing, after: updated,
    });
    setFlash(res, "success", `${req.body.name} updated.`);
    res.redirect("/admin/shop");
  });

  router.get("/reviews", requirePermission("reviews.read"), async (req, res) => {
    const [submissions, projects, deliveries, users, journals] = await Promise.all([
      store.list("submission"), store.list("project"), store.list("delivery"), store.list("user"), store.list("journal"),
    ]);
    const rows = sortNewest(submissions).map((submission) => {
      const currentProject = projects.find((item) => item.id === submission.projectId);
      const project = currentProject ? projectForReview(submission, currentProject) : null;
      const submissionJournals = journalsForReview(submission, journals);
      return {
        ...submission, project,
        maker: users.find((user) => user.id === project?.userId),
        reviewer: users.find((user) => user.id === submission.assignedReviewerId),
        devlogCount: submissionJournals.length,
        claimedMinutes: reviewMinutes(submissionJournals),
      };
    });
    res.render("admin/reviews", {
      title: "Project review queue",
      submissions: rows,
      deliveries: sortNewest(deliveries),
      reviewMode: ariClient.configured() ? "Ari sync + local review" : "Local review",
    });
  });

  router.get("/reviews/:id", requirePermission("projects.review"), async (req, res) => {
    const submission = await store.get("submission", req.params.id);
    if (!submission) return res.sendStatus(404);
    const project = await store.get("project", submission.projectId);
    if (!project) return res.sendStatus(404);
    const reviewProject = projectForReview(submission, project);
    const [maker, country, journals, actions, reviewers, github] = await Promise.all([
      store.get("user", project.userId), store.get("country", project.countryCode),
      store.list("journal"), store.list("review_action"), store.list("user"),
      githubClient.repository(reviewProject.repoUrl),
    ]);
    const reviewJournals = journalsForReview(submission, journals).sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    res.render("admin/review-detail", {
      title: `Review ${reviewProject.title}`, submission, project: reviewProject, maker, country,
      journals: reviewJournals,
      actions: sortNewest(actions.filter((item) => item.submissionId === submission.id)),
      reviewers,
      github,
      loggedMinutes: reviewMinutes(reviewJournals),
    });
  });

  router.post("/reviews/:id/claim", requirePermission("projects.review"), requireCsrf, async (req, res) => {
    const submission = await store.get("submission", req.params.id);
    if (!submission) return res.sendStatus(404);
    const before = structuredClone(submission);
    const release = req.body.action === "release";
    if (release && submission.assignedReviewerId && submission.assignedReviewerId !== req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "Only the assigned reviewer or an administrator can release this submission.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (!release && submission.assignedReviewerId && submission.assignedReviewerId !== req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "Another reviewer has already claimed this submission.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    submission.assignedReviewerId = release ? null : req.user.id;
    submission.assignedAt = release ? null : nowIso();
    if (!release && !submission.decision) submission.phase = "under_review";
    submission.updatedAt = nowIso();
    await store.put("submission", submission.id, submission);
    await addReviewAction(store, submission, req.user, release ? "released" : "claimed");
    await writeAudit(store, req.user, {
      action: release ? "review.released" : "review.claimed",
      entityType: "submission", entityId: submission.id,
      summary: `${release ? "Released" : "Claimed"} review ${submission.id}.`, before, after: submission,
    });
    const project = await store.get("project", submission.projectId);
    const maker = project ? await store.get("user", project.userId) : null;
    if (!release && project && maker) await notifier.projectUnderReview(maker, project);
    setFlash(res, "success", release ? "Submission returned to the queue." : "Submission claimed.");
    res.redirect(`/admin/reviews/${submission.id}`);
  });

  router.post("/reviews/:id/decision", requirePermission("projects.review"), requireCsrf, async (req, res) => {
    const submission = await store.get("submission", req.params.id);
    if (!submission) return res.sendStatus(404);
    const submissionBefore = structuredClone(submission);
    const secondPass = req.body.second_pass === "1";
    if (submission.decision) {
      setFlash(res, "error", "This review already has a final decision. Reopen the project before it can be shipped again.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (secondPass && (submission.phase !== "second_pass" || !submission.firstPass)) {
      setFlash(res, "error", "This review is not waiting for second pass.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (!secondPass && submission.phase === "second_pass") {
      setFlash(res, "error", "This review is waiting for second pass.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (secondPass && !hasPermission(req.user, "reviews.second_pass")) {
      return res.status(403).render("error", { title: "Second pass required", message: "Your account cannot complete second-pass reviews." });
    }
    if (secondPass && submission.firstPass.reviewer_id === req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "A different organizer must complete second pass.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (!secondPass && submission.assignedReviewerId && submission.assignedReviewerId !== req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "This submission is claimed by another reviewer.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    const decision = ["approved", "changes", "rejected"].includes(req.body.decision) ? req.body.decision : "";
    const prior = secondPass ? submission.firstPass : submission.review || {};
    const noteToMaker = String(req.body.note_to_maker || prior.note_to_maker || "").trim().slice(0, 3000);
    const internalNote = String(req.body.internal_note || "").trim().slice(0, 3000);
    const technicalNote = String(req.body.technical_note || prior.technical_note || "").trim().slice(0, 3000);
    const timeNote = String(req.body.time_note || prior.time_note || "").trim().slice(0, 2000);
    const criteria = {
      radioRelated: req.body.radio_related === "1" || Boolean(prior.criteria?.radioRelated),
      shipped: req.body.shipped === "1" || Boolean(prior.criteria?.shipped),
      publicSource: req.body.public_source === "1" || Boolean(prior.criteria?.publicSource),
      reproducible: req.body.reproducible === "1" || Boolean(prior.criteria?.reproducible),
      evidenceSufficient: req.body.evidence_sufficient === "1" || Boolean(prior.criteria?.evidenceSufficient),
      eligibleWork: req.body.eligible_work === "1" || Boolean(prior.criteria?.eligibleWork),
      distinctHours: req.body.distinct_hours === "1" || Boolean(prior.criteria?.distinctHours),
    };
    if (!decision || (["changes", "rejected"].includes(decision) && noteToMaker.length < 5)) {
      setFlash(res, "error", "Choose a decision and include useful participant feedback when returning or denying a project.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (decision === "approved" && (!Object.values(criteria).every(Boolean) || technicalNote.length < 5)) {
      setFlash(res, "error", "Confirm all approval checks and record the technical basis for approval.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    const precheckJournals = journalsForReview(submission, await store.list("journal"));
    const precheckMinutes = reviewMinutes(precheckJournals);
    const requestedMinutes = Math.min(precheckMinutes, Math.max(0, Math.round(Number(req.body.approved_minutes) || 0)));
    if (decision === "approved" && requestedMinutes < precheckMinutes && timeNote.length < 5) {
      setFlash(res, "error", "Explain why the approved time was reduced from the tracked time.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    if (!secondPass) {
      const timestamp = nowIso();
      submission.phase = "second_pass";
      submission.firstPass = {
        decision, approved_minutes: decision === "approved" ? requestedMinutes : 0,
        approved_hours: Math.round(((decision === "approved" ? requestedMinutes : 0) / 60) * 100) / 100,
        note_to_maker: noteToMaker, internal_note: internalNote, technical_note: technicalNote, time_note: timeNote, criteria,
        reviewer_id: req.user.id, reviewer_name: req.user.name, reviewed_at: timestamp,
      };
      submission.assignedReviewerId = req.user.id;
      submission.updatedAt = timestamp;
      await store.put("submission", submission.id, submission);
      await addReviewAction(store, submission, req.user, "first_pass", { decision, noteToMaker, internalNote, technicalNote, timeNote, criteria, approvedMinutes: submission.firstPass.approved_minutes });
      await writeAudit(store, req.user, { action: "review.first_pass", entityType: "submission", entityId: submission.id, summary: `Completed first pass for ${submission.id}.`, before: submissionBefore, after: submission, metadata: { projectId: submission.projectId, decision } });
      setFlash(res, "success", "First pass saved. A different second-pass reviewer must confirm the decision.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    await store.withLock(`review:${submission.id}`, async () => {
      const project = await store.get("project", submission.projectId);
      const journals = journalsForReview(submission, await store.list("journal"));
      const loggedMinutes = reviewMinutes(journals);
      const approvedMinutes = decision === "approved"
        ? Math.min(loggedMinutes, Math.max(0, Math.round(Number(req.body.approved_minutes) || 0)))
        : 0;
      const timestamp = nowIso();
      submission.phase = "reviewed";
      submission.decision = decision;
      submission.event = `review.${decision === "changes" ? "changes" : decision}`;
      submission.review = {
        ...(submission.review || {}), approved_minutes: approvedMinutes,
        approved_hours: Math.round((approvedMinutes / 60) * 100) / 100,
        note_to_maker: noteToMaker, internal_note: internalNote,
        technical_note: technicalNote, time_note: timeNote, criteria,
        reviewer_id: req.user.id, reviewer_name: req.user.name, reviewed_at: timestamp,
        first_pass: submission.firstPass,
        second_pass: { reviewer_id: req.user.id, reviewer_name: req.user.name, reviewed_at: timestamp, internal_note: internalNote },
      };
      submission.assignedReviewerId = req.user.id;
      submission.updatedAt = timestamp;
      await store.put("submission", submission.id, submission);
      project.status = { approved: "approved", changes: "needs_changes", rejected: "rejected" }[decision];
      project.updatedAt = timestamp;
      await store.put("project", project.id, project);

      const existingLedger = await store.get("ledger", submission.id);
      // Hardware is funded before its build starts. A final hardware review confirms
      // the finished project only; it must never turn logged build time into shop Hertz.
      const desiredHertz = decision === "approved" && project.track !== "hardware"
        ? Math.round(((approvedMinutes * 5) / 60) * 100) / 100
        : 0;
      const previousHertz = Math.max(0, Number(existingLedger?.delta) || 0);
      const maker = await store.get("user", project.userId);
      if (maker && desiredHertz !== previousHertz) {
        maker.hertz = Math.max(0, Math.round((maker.hertz + desiredHertz - previousHertz) * 100) / 100);
        maker.updatedAt = timestamp;
        await store.put("user", maker.id, maker);
      }
      if (desiredHertz > 0) {
        await store.put("ledger", submission.id, {
          id: submission.id, userId: project.userId, submissionId: submission.id,
          delta: desiredHertz, reason: `CQ review by ${req.user.name}`, createdAt: existingLedger?.createdAt || timestamp, updatedAt: timestamp,
        });
      } else if (existingLedger) await store.delete("ledger", submission.id);
      await addReviewAction(store, submission, req.user, `second_pass_${decision}`, {
        noteToMaker, internalNote, technicalNote, timeNote, criteria, approvedMinutes,
      });
      await writeAudit(store, req.user, {
        action: `review.second_pass.${decision}`, entityType: "submission", entityId: submission.id,
        summary: `Completed second pass with a ${decision} decision for ${project.title}.`,
        before: submissionBefore, after: submission,
        metadata: { projectId: project.id, approvedMinutes, previousHertz, awardedHertz: desiredHertz },
      });
      if (maker) await notifier.projectDecision(maker, project, submission.event, submission.review);
    });
    setFlash(res, "success", "Second pass saved and the participant was notified.");
    res.redirect(`/admin/reviews/${submission.id}`);
  });

  router.get("/countries", requirePermission("countries.manage"), async (req, res) => {
    const countries = (await store.list("country")).sort((a, b) => a.sortOrder - b.sortOrder);
    res.render("admin/countries", { title: "Country policies", countries });
  });

  router.get("/notifications", requirePermission("notifications.read"), async (req, res) => {
    const notifications = sortNewest(await store.list("notification"));
    res.render("admin/notifications", {
      title: "Slack notifications",
      notifications,
      slackConfigured: notifier.configured(),
    });
  });

  router.get("/audit", requirePermission("audit.read"), async (req, res) => {
    const entries = sortNewest(await store.list("audit"));
    res.render("admin/audit", { title: "Audit log", entries });
  });

  router.post("/countries", requirePermission("countries.manage"), requireCsrf, async (req, res) => {
    const code = String(req.body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
    if (!code || !String(req.body.name || "").trim()) {
      setFlash(res, "error", "Country code and name are required.");
      return res.redirect("/admin/countries");
    }
    const country = countryInput(req.body, code);
    await store.put("country", code, country);
    await writeAudit(store, req.user, {
      action: "country.created", entityType: "country", entityId: code,
      summary: `Added the ${country.name} country policy.`, after: country,
    });
    setFlash(res, "success", `${req.body.name} added.`);
    res.redirect("/admin/countries");
  });

  router.post("/countries/:id", requirePermission("countries.manage"), requireCsrf, async (req, res) => {
    const existing = await store.get("country", req.params.id);
    if (!existing) return res.sendStatus(404);
    const updated = countryInput(req.body, existing.id);
    await store.put("country", existing.id, updated);
    await writeAudit(store, req.user, {
      action: "country.updated", entityType: "country", entityId: existing.id,
      summary: `Updated the ${updated.name} country policy.`, before: existing, after: updated,
    });
    setFlash(res, "success", `${req.body.name} policy updated.`);
    res.redirect("/admin/countries");
  });

  return router;
}

async function addReviewAction(store, submission, reviewer, action, details = {}) {
  const timestamp = nowIso();
  const record = {
    id: randomId("review_"), submissionId: submission.id, projectId: submission.projectId,
    reviewerId: reviewer.id, reviewerName: reviewer.name, action, ...details,
    createdAt: timestamp, updatedAt: timestamp,
  };
  await store.put("review_action", record.id, record);
  return record;
}

async function uploadProductImage(cdnClient, file, fallback = "") {
  if (!file) return fallback;
  if (!cdnClient?.configured()) throw new Error("Product image uploads are not configured. Add HACKCLUB_CDN_API_KEY first.");
  const image = await cdnClient.upload(file);
  return image.url;
}

function productInput(body, id, { image = "" } = {}) {
  return {
    id,
    name: String(body.name || "").trim().slice(0, 120),
    description: String(body.description || "").trim().slice(0, 1000),
    price: Math.max(0, Number.parseInt(body.price || "0", 10) || 0),
    stock: Math.max(0, Number.parseInt(body.stock || "0", 10) || 0),
    image: String(image || body.image || "").trim().slice(0, 500),
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
