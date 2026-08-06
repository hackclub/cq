import { Router } from "express";
import { requireAuth, requireCsrf } from "../auth.js";
import { buildAriPayload } from "../ari.js";
import { nowIso, randomId, setFlash } from "../utils.js";
import { isHttpUrl, projectInput, validateProject } from "../validation.js";

const milestoneTemplates = [
  ["plan", "Choose your licence path and make a study plan"],
  ["listen", "Listen to a local repeater, satellite, or the ISS"],
  ["licence", "Pass your amateur radio exam"],
  ["callsign", "Receive your callsign"],
  ["build", "Build and document a radio project"],
  ["ship", "Prepare your project for review"],
];

async function ownedProject(store, projectId, userId) {
  const project = await store.get("project", projectId);
  return project?.userId === userId ? project : null;
}

function formValues(project) {
  return {
    ...project,
    repo_url: project.repoUrl,
    demo_url: project.demoUrl,
    thumbnail_url: project.thumbnailUrl,
    hackatime_projects: project.hackatimeProjects.join(", "),
    project_type: project.projectType,
    radio_relevance: project.radioRelevance,
    country_code: project.countryCode,
    license_goal: project.licenseGoal,
    ai_statement: project.aiStatement,
    tags: project.tags.join(", "),
    is_update: project.isUpdate,
    update_message: project.updateMessage,
  };
}

function toProjectRecord(id, userId, input, existing = {}) {
  const timestamp = nowIso();
  return {
    id,
    userId,
    title: input.title,
    description: input.description,
    repoUrl: input.repoUrl,
    demoUrl: input.demoUrl,
    thumbnailUrl: input.thumbnailUrl,
    hackatimeProjects: input.hackatimeProjects,
    evidence: input.evidence.length ? input.evidence : ["commits", "elapsed", "devlog"],
    track: input.track,
    status: existing.status ?? "building",
    projectType: input.projectType,
    radioRelevance: input.radioRelevance,
    countryCode: input.countryCode,
    licenseGoal: input.licenseGoal,
    callsign: input.callsign,
    aiStatement: input.aiStatement,
    tags: input.tags,
    isUpdate: input.isUpdate,
    updateMessage: input.updateMessage,
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

async function details(store, projectId) {
  const [milestones, journals, submissions] = await Promise.all([
    store.list("milestone"),
    store.list("journal"),
    store.list("submission"),
  ]);
  return {
    milestones: milestones.filter((item) => item.projectId === projectId).sort((a, b) => a.sortOrder - b.sortOrder),
    journals: journals.filter((item) => item.projectId === projectId).sort((a, b) =>
      b.entryDate.localeCompare(a.entryDate) || String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    submissions: submissions.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

function readiness(project, journals, user) {
  const input = projectInput(formValues(project));
  const journalMinutes = journals.reduce((sum, journal) => sum + journal.minutes, 0);
  const errors = validateProject(input, { forSubmission: true, journalMinutes });
  if (journals.some((journal) => journalImages(journal).length === 0)) {
    errors.push("Add a public progress image to every devlog.");
  }
  if (!user.slackId) errors.push("Add your Hack Club Slack user ID to your profile.");
  if (user.yswsEligible !== true) errors.push("CQ could not confirm that your Hack Club account is currently YSWS eligible.");
  return { errors, journalMinutes };
}

function journalImages(journal = {}) {
  const candidates = Array.isArray(journal.imageUrls) && journal.imageUrls.length
    ? journal.imageUrls
    : [journal.imageUrl];
  return [...new Set(candidates.map((url) => String(url || "").trim()).filter(isHttpUrl))];
}

function parseImageUrls(body = {}) {
  const submitted = String(body.image_urls || body.image_url || "");
  return [...new Set(submitted
    .split(/\r?\n/)
    .map((url) => url.trim().slice(0, 500))
    .filter(Boolean))]
    .slice(0, 8);
}

function journalInput(body = {}) {
  const imageUrls = parseImageUrls(body);
  return {
    entryDate: String(body.entry_date || ""),
    minutes: Number.parseInt(body.minutes, 10),
    title: String(body.title || "").trim().slice(0, 120),
    text: String(body.text || "").trim().slice(0, 2000),
    imageUrls,
    imageUrl: imageUrls[0] || "",
  };
}

function validateJournal(input) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) errors.push("Choose a date for the devlog.");
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) {
    errors.push("Enter between 1 and 1,440 minutes.");
  }
  if (input.title.length < 3) errors.push("Give this devlog a short title.");
  if (input.text.length < 5) errors.push("Describe what changed in at least 5 characters.");
  if (input.imageUrls.length === 0) errors.push("Add at least one public HTTP or HTTPS progress image URL.");
  if (input.imageUrls.some((url) => !isHttpUrl(url))) errors.push("Every progress image must use a public HTTP or HTTPS URL.");
  return errors;
}

async function activeCountries(store) {
  return (await store.list("country"))
    .filter((country) => country.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

async function formContext(store, hackatimeClient, userId, force = false) {
  const [countries, hackatime] = await Promise.all([
    activeCountries(store),
    hackatimeClient.projects(userId, { force }),
  ]);
  return { countries, hackatime };
}

function validateHackatimeSelection(input, hackatime) {
  if (input.hackatimeProjects.length === 0) return [];
  if (!hackatime.connected) return ["Connect Hackatime before linking coding projects."];
  if (hackatime.error === "unavailable") {
    return ["CQ could not verify those Hackatime projects. Refresh the list and try again."];
  }
  const available = new Set(hackatime.projects.map((project) => project.name));
  return input.hackatimeProjects
    .filter((name) => !available.has(name))
    .map((name) => `“${name}” is not available in your connected Hackatime account.`);
}

export function projectRoutes({ store, config, ariClient, hackatimeClient, notifier }) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const [allProjects, milestones, journals] = await Promise.all([
      store.list("project"),
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
          journalMinutes: journals.filter((item) => item.projectId === project.id).reduce((sum, item) => sum + item.minutes, 0),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.render("projects/index", { title: "Your projects", projects });
  });

  router.get("/new", async (req, res) => {
    const context = await formContext(store, hackatimeClient, req.user.id);
    res.render("projects/form", {
      title: "Start a radio project", errors: [], values: {}, editing: false,
      ...context,
    });
  });

  router.post("/new", requireCsrf, async (req, res) => {
    const input = projectInput(req.body);
    const context = await formContext(store, hackatimeClient, req.user.id);
    const errors = [...validateProject(input), ...validateHackatimeSelection(input, context.hackatime)];
    if (errors.length) {
      return res.status(422).render("projects/form", {
        title: "Start a radio project", errors, values: req.body, editing: false,
        ...context,
      });
    }
    const id = randomId("cq_");
    const project = toProjectRecord(id, req.user.id, input);
    await store.put("project", id, project);
    await Promise.all(milestoneTemplates.map(async ([slug, title], index) => {
      const milestone = { id: `${id}_${slug}`, projectId: id, slug, title, complete: false, sortOrder: index };
      await store.put("milestone", milestone.id, milestone);
    }));
    setFlash(res, "success", "Project created. Your path to the air is ready.");
    res.redirect(`/app/projects/${id}`);
  });

  router.get("/:id", async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const [projectDetails, country] = await Promise.all([
      details(store, project.id),
      store.get("country", project.countryCode),
    ]);
    res.render("projects/show", {
      title: project.title,
      project,
      ...projectDetails,
      journals: projectDetails.journals.map((journal) => ({
        ...journal,
        imageUrls: journalImages(journal),
      })),
      readiness: readiness(project, projectDetails.journals, req.user),
      ariConfigured: ariClient.configured(),
      country,
    });
  });

  router.get("/:id/edit", async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const context = await formContext(store, hackatimeClient, req.user.id);
    res.render("projects/form", {
      title: `Edit ${project.title}`, errors: [], values: formValues(project), editing: true, project,
      ...context,
    });
  });

  router.post("/:id/edit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const input = projectInput(req.body);
    const context = await formContext(store, hackatimeClient, req.user.id);
    const errors = [...validateProject(input), ...validateHackatimeSelection(input, context.hackatime)];
    if (errors.length) {
      return res.status(422).render("projects/form", {
        title: `Edit ${project.title}`, errors, values: req.body, editing: true, project,
        ...context,
      });
    }
    await store.put("project", project.id, toProjectRecord(project.id, req.user.id, input, project));
    setFlash(res, "success", "Project details saved.");
    res.redirect(`/app/projects/${project.id}`);
  });

  router.post("/:id/milestones/:milestoneId", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const milestone = await store.get("milestone", req.params.milestoneId);
    if (!milestone || milestone.projectId !== project.id) return res.sendStatus(404);
    milestone.complete = !milestone.complete;
    await store.put("milestone", milestone.id, milestone);
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    res.redirect(`/app/projects/${project.id}#milestones`);
  });

  router.post("/:id/journals", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const input = journalInput(req.body);
    const errors = validateJournal(input);
    if (errors.length) {
      setFlash(res, "error", errors[0]);
      return res.redirect(`/app/projects/${project.id}#work-log`);
    }
    const journal = {
      id: randomId("log_"),
      projectId: project.id,
      ...input,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.put("journal", journal.id, journal);
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    setFlash(res, "success", "Devlog added.");
    res.redirect(`/app/projects/${project.id}#work-log`);
  });

  router.post("/:id/journals/:journalId/edit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    const journal = await store.get("journal", req.params.journalId);
    if (!project || journal?.projectId !== project.id) return res.sendStatus(404);
    const input = journalInput(req.body);
    const errors = validateJournal(input);
    if (errors.length) {
      setFlash(res, "error", errors[0]);
      return res.redirect(`/app/projects/${project.id}#devlog-${journal.id}`);
    }
    await store.put("journal", journal.id, { ...journal, ...input, updatedAt: nowIso() });
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    setFlash(res, "success", "Devlog updated.");
    res.redirect(`/app/projects/${project.id}#devlog-${journal.id}`);
  });

  router.post("/:id/journals/:journalId/delete", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    const journal = await store.get("journal", req.params.journalId);
    if (!project || journal?.projectId !== project.id) return res.sendStatus(404);
    await store.delete("journal", journal.id);
    setFlash(res, "success", "Devlog removed.");
    res.redirect(`/app/projects/${project.id}#work-log`);
  });

  router.post("/:id/archive", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    project.status = "archived";
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    setFlash(res, "success", `${project.title} was archived.`);
    res.redirect("/app/projects");
  });

  router.post("/:id/submit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const projectDetails = await details(store, project.id);
    const state = readiness(project, projectDetails.journals, req.user);
    if (state.errors.length) {
      setFlash(res, "error", state.errors[0]);
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    if (!ariClient.configured()) {
      setFlash(res, "error", "The organizer still needs to connect CQ to the project review service.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    const country = await store.get("country", project.countryCode);
    const payload = buildAriPayload({ project, user: req.user, journals: projectDetails.journals, config, country });
    const timestamp = nowIso();
    const submission = {
      id: randomId("ship_"),
      projectId: project.id,
      externalId: project.id,
      ariId: null,
      payload,
      phase: "processing",
      decision: null,
      event: null,
      review: null,
      attemptCount: 1,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.put("submission", submission.id, submission);
    try {
      const result = await ariClient.submit(payload);
      if (![200, 202].includes(result.status)) {
        submission.phase = "error";
        submission.lastError =
          result.status === 409 ? "This project is already queued for review." :
          `The review service could not accept this project (status ${result.status}).`;
        submission.updatedAt = nowIso();
        await store.put("submission", submission.id, submission);
        setFlash(res, "error", submission.lastError);
        return res.redirect(`/app/projects/${project.id}#submission`);
      }
      submission.ariId = result.body?.id ?? null;
      submission.updatedAt = nowIso();
      await store.put("submission", submission.id, submission);
      project.status = "submitted";
      project.updatedAt = nowIso();
      await store.put("project", project.id, project);
      await notifier.projectSubmitted(req.user, project);
      setFlash(res, "success", result.status === 200 ? "This exact version was already queued." : "Project submitted for review.");
    } catch (error) {
      req.app.locals.logger.error("Ari submission failed", error);
      submission.phase = "error";
      submission.lastError = error.message;
      submission.updatedAt = nowIso();
      await store.put("submission", submission.id, submission);
      setFlash(res, "error", "The review service could not be reached. Your project is safe; try again shortly.");
    }
    res.redirect(`/app/projects/${project.id}#submission`);
  });

  router.post("/:id/status", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const submissions = (await store.list("submission"))
      .filter((item) => item.projectId === project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const submission = submissions[0];
    if (!submission) {
      setFlash(res, "error", "This project has not been submitted for review yet.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    try {
      const result = await ariClient.status({ externalId: project.id, ariId: submission.ariId });
      if (!result.ok) throw new Error(result.body?.message || `The review service returned ${result.status}`);
      const previousPhase = submission.phase;
      submission.ariId = result.body.id ?? submission.ariId;
      submission.phase = result.body.phase;
      submission.decision = result.body.decision ?? null;
      submission.updatedAt = nowIso();
      await store.put("submission", submission.id, submission);
      if (previousPhase !== submission.phase && ["review", "under_review", "second_pass"].includes(submission.phase)) {
        await notifier.projectUnderReview(req.user, project);
      }
      setFlash(res, "success", "Review status refreshed.");
    } catch (error) {
      req.app.locals.logger.error("Ari status refresh failed", error);
      setFlash(res, "error", "Could not refresh the review status.");
    }
    res.redirect(`/app/projects/${project.id}#submission`);
  });

  router.post("/:id/withdraw", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    try {
      const result = await ariClient.withdraw(project.id);
      if (!result.ok) throw new Error(result.body?.message || result.body?.error || `The review service returned ${result.status}`);
      const submissions = await store.list("submission");
      await Promise.all(submissions
        .filter((item) => item.projectId === project.id && !item.decision)
        .map((item) => store.put("submission", item.id, { ...item, phase: "withdrawn", updatedAt: nowIso() })));
      project.status = "building";
      project.updatedAt = nowIso();
      await store.put("project", project.id, project);
      setFlash(res, "success", "The open review submission was withdrawn.");
    } catch (error) {
      req.app.locals.logger.error("Ari withdrawal failed", error);
      setFlash(res, "error", "The review submission could not be withdrawn. It may already have a decision.");
    }
    res.redirect(`/app/projects/${project.id}#submission`);
  });

  return router;
}
