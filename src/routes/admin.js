import { Router } from "express";
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

export function adminRoutes({ store, config, ariClient, githubClient, notifier }) {
  const router = Router();
  router.use(requireOrganizer);

  router.get("/", async (req, res) => {
    const canUsers = hasPermission(req.user, "users.manage");
    const canReview = hasPermission(req.user, "projects.review");
    const canOrders = hasPermission(req.user, "orders.manage");
    const canShop = hasPermission(req.user, "shop.manage");
    const [users, projects, orders, submissions, deliveries, products] = await Promise.all([
      canUsers ? store.list("user") : [], canReview ? store.list("project") : [], canOrders ? store.list("order") : [],
      canReview ? store.list("submission") : [], canUsers ? store.list("delivery") : [], canShop ? store.list("product") : [],
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
      reviewMode: ariClient.configured() ? "Ari sync + local review" : "Local review",
    });
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
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    await writeAudit(store, req.user, {
      action: "project.status_updated", entityType: "project", entityId: project.id,
      summary: `Changed ${project.title} from ${previousStatus} to ${project.status}.`, before, after: project,
    });
    if (previousStatus !== project.status) {
      const user = await store.get("user", project.userId);
      const event = { submitted: "review.requeued" }[project.status];
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
    res.render("admin/shop", { title: "Manage shop", products });
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
    const updated = { ...existing, ...productInput(req.body, existing.id) };
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
        claimedMinutes: submissionJournals.reduce((sum, item) => sum + Math.max(0, Number(item.minutes) || 0), 0),
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
      loggedMinutes: reviewJournals.reduce((sum, item) => sum + Math.max(0, Number(item.minutes) || 0), 0),
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
    if (submission.assignedReviewerId && submission.assignedReviewerId !== req.user.id && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", "This submission is claimed by another reviewer.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    const decision = ["approved", "changes", "rejected"].includes(req.body.decision) ? req.body.decision : "";
    const noteToMaker = String(req.body.note_to_maker || "").trim().slice(0, 3000);
    const internalNote = String(req.body.internal_note || "").trim().slice(0, 3000);
    const technicalNote = String(req.body.technical_note || "").trim().slice(0, 3000);
    const timeNote = String(req.body.time_note || "").trim().slice(0, 2000);
    const criteria = {
      radioRelated: req.body.radio_related === "1",
      shipped: req.body.shipped === "1",
      publicSource: req.body.public_source === "1",
      reproducible: req.body.reproducible === "1",
      evidenceSufficient: req.body.evidence_sufficient === "1",
      eligibleWork: req.body.eligible_work === "1",
      distinctHours: req.body.distinct_hours === "1",
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
    const precheckMinutes = precheckJournals.reduce((sum, item) => sum + Math.max(0, Number(item.minutes) || 0), 0);
    const requestedMinutes = Math.min(precheckMinutes, Math.max(0, Math.round(Number(req.body.approved_minutes) || 0)));
    if (decision === "approved" && requestedMinutes < precheckMinutes && timeNote.length < 5) {
      setFlash(res, "error", "Explain why the approved time was reduced from the tracked time.");
      return res.redirect(`/admin/reviews/${submission.id}`);
    }
    await store.withLock(`review:${submission.id}`, async () => {
      const project = await store.get("project", submission.projectId);
      const journals = journalsForReview(submission, await store.list("journal"));
      const loggedMinutes = journals.reduce((sum, item) => sum + Math.max(0, Number(item.minutes) || 0), 0);
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
      };
      submission.assignedReviewerId = req.user.id;
      submission.updatedAt = timestamp;
      await store.put("submission", submission.id, submission);
      project.status = { approved: "approved", changes: "needs_changes", rejected: "rejected" }[decision];
      project.updatedAt = timestamp;
      await store.put("project", project.id, project);

      const existingLedger = await store.get("ledger", submission.id);
      const desiredHertz = decision === "approved" ? Math.round(((approvedMinutes * 5) / 60) * 100) / 100 : 0;
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
      await addReviewAction(store, submission, req.user, decision, {
        noteToMaker, internalNote, technicalNote, timeNote, criteria, approvedMinutes,
      });
      await writeAudit(store, req.user, {
        action: `review.${decision}`, entityType: "submission", entityId: submission.id,
        summary: `Saved a ${decision} decision for ${project.title}.`,
        before: submissionBefore, after: submission,
        metadata: { projectId: project.id, approvedMinutes, previousHertz, awardedHertz: desiredHertz },
      });
      if (maker) await notifier.projectDecision(maker, project, submission.event, submission.review);
    });
    setFlash(res, "success", "Review decision saved and the participant was notified.");
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
