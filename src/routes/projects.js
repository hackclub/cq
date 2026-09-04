import { Router } from "express";
import multer from "multer";
import { writeAudit } from "../audit.js";
import { hasPermission, requireAuth, requireCsrf } from "../auth.js";
import { buildAriPayload } from "../ari.js";
import { nowIso, randomId, setFlash } from "../utils.js";
import { isHttpUrl, projectInput, validateFundingRequest, validateProject } from "../validation.js";

function githubUsername(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    return parsed.pathname.split("/").filter(Boolean)[0] || "";
  } catch { return ""; }
}

function formatBirthday(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
  return String(value || "").trim();
}

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
    original_work: project.originalWork,
    not_school_assignment: project.notSchoolAssignment,
    not_paid_hack_club_work: project.notPaidHackClubWork,
    estimated_hours: project.estimatedHours,
    build_plan: project.buildPlan,
    bom: project.bom,
    bom_items: project.bomItems?.length ? JSON.stringify(project.bomItems) : "",
    design_url: project.designUrl,
    test_plan: project.testPlan,
  };
}

function hackatimeTotals(projectNames, availableProjects) {
  const selected = new Set(projectNames);
  return Object.fromEntries(availableProjects
    .filter((project) => selected.has(project.name))
    .map((project) => [project.name, Math.max(0, Number(project.totalSeconds) || 0)]));
}

function toProjectRecord(id, userId, input, existing = {}, availableHackatimeProjects = []) {
  const timestamp = nowIso();
  const currentTotals = hackatimeTotals(input.hackatimeProjects, availableHackatimeProjects);
  const existingBaseline = existing.hackatimeBaseline || {};
  return {
    id,
    userId,
    title: input.title,
    description: input.description,
    repoUrl: input.repoUrl,
    demoUrl: input.demoUrl,
    thumbnailUrl: input.thumbnailUrl,
    hackatimeProjects: input.hackatimeProjects,
    hackatimeBaseline: Object.fromEntries(input.hackatimeProjects.map((name) => [
      name,
      Number.isFinite(existingBaseline[name]) ? existingBaseline[name] : (currentTotals[name] ?? 0),
    ])),
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
    originalWork: input.originalWork,
    notSchoolAssignment: input.notSchoolAssignment,
    notPaidHackClubWork: input.notPaidHackClubWork,
    estimatedHours: input.estimatedHours,
    buildPlan: input.buildPlan,
    bom: input.bom,
    bomItems: input.bomItems,
    designUrl: input.designUrl,
    testPlan: input.testPlan,
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

async function details(store, projectId) {
  const [journals, submissions] = await Promise.all([
    store.list("journal"),
    store.list("submission"),
  ]);
  return {
    journals: journals.filter((item) => item.projectId === projectId).sort((a, b) =>
      b.entryDate.localeCompare(a.entryDate) || String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    submissions: submissions.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

async function submittedJournal(store, journalId) {
  return (await store.list("submission")).some((item) => {
    if (!(item.journalIds || []).includes(journalId)) return false;
    if (!Array.isArray(item.journalSnapshots)) return true;
    return !item.decision && !["withdrawn", "error"].includes(item.phase);
  });
}

function hackatimeActivity(project, journals, hackatime) {
  if (!project.hackatimeProjects.length) {
    return { ready: false, reason: "Link at least one Hackatime project before posting a devlog.", seconds: 0, minutes: 0, currentTotals: {} };
  }
  if (!hackatime.connected) {
    return { ready: false, reason: "Connect Hackatime before posting a devlog.", seconds: 0, minutes: 0, currentTotals: {} };
  }
  if (hackatime.error === "unavailable") {
    return { ready: false, reason: "CQ could not refresh your Hackatime activity. Try again in a moment.", seconds: 0, minutes: 0, currentTotals: {} };
  }
  const currentTotals = hackatimeTotals(project.hackatimeProjects, hackatime.projects);
  const missing = project.hackatimeProjects.filter((name) => currentTotals[name] === undefined);
  if (missing.length) {
    return { ready: false, reason: `Hackatime no longer returned: ${missing.join(", ")}. Refresh or update the linked projects.`, seconds: 0, minutes: 0, currentTotals };
  }
  const previous = journals[0]?.hackatimeSnapshot || project.hackatimeBaseline || {};
  const seconds = project.hackatimeProjects.reduce(
    (sum, name) => sum + Math.max(0, currentTotals[name] - Math.max(0, Number(previous[name]) || 0)),
    0,
  );
  return {
    ready: seconds >= 60,
    reason: seconds >= 60 ? "" : "No new Hackatime activity has appeared on the linked projects since your last devlog.",
    seconds,
    minutes: Math.round((seconds / 60) * 100) / 100,
    currentTotals,
  };
}

function submissionJournals(journals, submissions) {
  const usedIds = new Set(submissions.flatMap((item) => item.journalIds || []));
  if (usedIds.size) return journals.filter((journal) => !usedIds.has(journal.id));
  if (submissions.length) {
    const latestCreatedAt = submissions[0].createdAt;
    return journals.filter((journal) => String(journal.createdAt || "") > latestCreatedAt);
  }
  return journals;
}

function readiness(project, journals, user, { hasPriorSubmission = false } = {}) {
  const input = projectInput(formValues(project));
  const journalMinutes = journals.reduce((sum, journal) => sum + journal.minutes, 0);
  const errors = validateProject(input, { forSubmission: true, journalMinutes, journalCount: journals.length });
  if (journals.some((journal) => journalImages(journal).length === 0)) {
    errors.push("Add a public progress image to every devlog.");
  }
  if (!user.slackId) errors.push("Add your Hack Club Slack user ID to your profile.");
  if (user.yswsEligible !== true) errors.push("CQ could not confirm that your Hack Club account is currently YSWS eligible.");
  if (![user.firstName, user.lastName, user.birthday, user.addressLine1, user.city, user.region, user.postalCode, user.addressCountry].every(Boolean)) {
    errors.push("Complete your legal name, birthday, and address in your profile before submitting.");
  }
  if (hasPriorSubmission && journals.length === 0) errors.push("Add new devlogs before submitting a project update.");
  if (hasPriorSubmission && !project.isUpdate) errors.push("Mark this as an update and describe the meaningful new work before resubmitting.");
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
    title: String(body.title || "").trim().slice(0, 120),
    text: String(body.text || "").trim().slice(0, 2000),
    imageUrls,
    imageUrl: imageUrls[0] || "",
  };
}

function validateJournal(input) {
  const errors = [];
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

export function projectRoutes({ store, config, ariClient, hackatimeClient, cdnClient, notifier }) {
  const router = Router();
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 8 },
    fileFilter: (req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)),
  });
  router.use(requireAuth);

  router.post("/uploads/images", imageUpload.array("images", 8), requireCsrf, async (req, res) => {
    if (!cdnClient?.configured()) return res.status(503).json({ error: "Image uploads are not configured yet." });
    if (!req.files?.length) return res.status(422).json({ error: "Choose at least one JPG, PNG, WebP, or GIF image." });
    try {
      const uploaded = [];
      for (const file of req.files) uploaded.push(await cdnClient.upload(file));
      return res.json({ images: uploaded });
    } catch (error) {
      req.app.locals.logger.error("Devlog image upload failed", error);
      return res.status(502).json({ error: "The image upload failed. Please try again." });
    }
  });

  router.get("/", async (req, res) => {
    const [allProjects, journals] = await Promise.all([
      store.list("project"),
      store.list("journal"),
    ]);
    const scope = ["active", "all", "archived"].includes(req.query.view) ? req.query.view : "active";
    const mine = allProjects.filter((project) => project.userId === req.user.id);
    const projects = mine
      .filter((project) => scope === "all" || (scope === "archived" ? project.status === "archived" : project.status !== "archived"))
      .map((project) => ({
        ...project,
        journalMinutes: journals.filter((item) => item.projectId === project.id).reduce((sum, item) => sum + item.minutes, 0),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.render("projects/index", { title: "Your projects", projects, scope, counts: { active: mine.filter((p) => p.status !== "archived").length, all: mine.length, archived: mine.filter((p) => p.status === "archived").length } });
  });

  router.get("/new", async (req, res) => {
    const context = await formContext(store, hackatimeClient, req.user.id);
    res.render("projects/form", {
      title: "Start a radio project", errors: [], values: {}, editing: false,
      imageUploadsConfigured: Boolean(cdnClient?.configured()),
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
        imageUploadsConfigured: Boolean(cdnClient?.configured()),
        ...context,
      });
    }
    const id = randomId("cq_");
    const project = toProjectRecord(id, req.user.id, input, {}, context.hackatime.projects);
    await store.put("project", id, project);
    setFlash(res, "success", "Project created. Your path to the air is ready.");
    res.redirect(`/app/projects/${id}`);
  });

  router.get("/:id", async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    req.app.locals.logger.info(`${req.user.id} opened project ${project.id}`);
    const [projectDetails, country, hackatime, fundingRequests] = await Promise.all([
      details(store, project.id),
      store.get("country", project.countryCode),
      hackatimeClient.projects(req.user.id, { force: true }),
      store.list("funding_request"),
    ]);
    if (project.hackatimeProjects.length && !project.hackatimeBaseline) {
      project.hackatimeBaseline = hackatimeTotals(project.hackatimeProjects, hackatime.projects);
      project.updatedAt = nowIso();
      await store.put("project", project.id, project);
    }
    res.render("projects/show", {
      title: project.title,
      project,
      ...projectDetails,
      journals: projectDetails.journals.map((journal) => ({
        ...journal,
        imageUrls: journalImages(journal),
      })),
      readiness: readiness(project, submissionJournals(projectDetails.journals, projectDetails.submissions), req.user, { hasPriorSubmission: projectDetails.submissions.length > 0 }),
      ariConfigured: ariClient.configured(),
      projectLocked: project.status === "submitted",
      lockedJournalIds: [...new Set(projectDetails.submissions.flatMap((item) => {
        const locksEvidence = !Array.isArray(item.journalSnapshots) || (!item.decision && !["withdrawn", "error"].includes(item.phase));
        return locksEvidence ? item.journalIds || [] : [];
      }))],
      country,
      hackatimeActivity: hackatimeActivity(project, projectDetails.journals, hackatime),
      imageUploadsConfigured: Boolean(cdnClient?.configured()),
      fundingRequests: fundingRequests.filter((item) => item.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  });

  router.get("/:id/edit", async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    if (project.status === "submitted") {
      setFlash(res, "error", "This shipped version is locked while it is being reviewed.");
      return res.redirect(`/app/projects/${project.id}`);
    }
    const context = await formContext(store, hackatimeClient, req.user.id);
    res.render("projects/form", {
      title: `Edit ${project.title}`, errors: [], values: formValues(project), editing: true, project,
      imageUploadsConfigured: Boolean(cdnClient?.configured()),
      ...context,
    });
  });

  router.post("/:id/edit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    if (project.status === "submitted") {
      setFlash(res, "error", "This shipped version is locked while it is being reviewed.");
      return res.redirect(`/app/projects/${project.id}`);
    }
    const input = projectInput(req.body);
    const context = await formContext(store, hackatimeClient, req.user.id);
    const errors = [...validateProject(input), ...validateHackatimeSelection(input, context.hackatime)];
    if (errors.length) {
      return res.status(422).render("projects/form", {
        title: `Edit ${project.title}`, errors, values: req.body, editing: true, project,
        imageUploadsConfigured: Boolean(cdnClient?.configured()),
        ...context,
      });
    }
    await store.put("project", project.id, toProjectRecord(project.id, req.user.id, input, project, context.hackatime.projects));
    setFlash(res, "success", "Project details saved.");
    res.redirect(`/app/projects/${project.id}`);
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
    try {
      await store.withLock(`devlog:${project.id}`, async () => {
        if (project.track === "hardware") {
          const timestamp = nowIso();
          const journal = { id: randomId("log_"), projectId: project.id, ...input, entryDate: timestamp.slice(0, 10), minutes: 0, hackatimeSeconds: 0, hackatimeSnapshot: {}, hackatimeProjects: [], createdAt: timestamp, updatedAt: timestamp };
          await store.put("journal", journal.id, journal);
          await store.put("project", project.id, { ...project, updatedAt: timestamp });
          return;
        }
        const [freshDetails, hackatime] = await Promise.all([
          details(store, project.id),
          hackatimeClient.projects(req.user.id, { force: true }),
        ]);
        const activity = hackatimeActivity(project, freshDetails.journals, hackatime);
        if (!activity.ready) throw new Error(activity.reason);
        const timestamp = nowIso();
        const journal = {
          id: randomId("log_"),
          projectId: project.id,
          ...input,
          entryDate: timestamp.slice(0, 10),
          minutes: activity.minutes,
          hackatimeSeconds: activity.seconds,
          hackatimeSnapshot: activity.currentTotals,
          hackatimeProjects: [...project.hackatimeProjects],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await store.put("journal", journal.id, journal);
        project.updatedAt = timestamp;
        await store.put("project", project.id, project);
      });
    } catch (error) {
      setFlash(res, "error", error.message || "Could not calculate new Hackatime activity.");
      return res.redirect(`/app/projects/${project.id}#work-log`);
    }
    setFlash(res, "success", "Devlog added.");
    res.redirect(`/app/projects/${project.id}#work-log`);
  });

  router.post("/:id/journals/:journalId/edit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    const journal = await store.get("journal", req.params.journalId);
    if (!project || journal?.projectId !== project.id) return res.sendStatus(404);
    if (await submittedJournal(store, journal.id)) {
      setFlash(res, "error", "A devlog included in a shipped version cannot be changed.");
      return res.redirect(`/app/projects/${project.id}#devlog-${journal.id}`);
    }
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
    if (await submittedJournal(store, journal.id)) {
      setFlash(res, "error", "A devlog included in a shipped version cannot be removed.");
      return res.redirect(`/app/projects/${project.id}#devlog-${journal.id}`);
    }
    await store.delete("journal", journal.id);
    setFlash(res, "success", "Devlog removed.");
    res.redirect(`/app/projects/${project.id}#work-log`);
  });

  router.post("/:id/archive", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    if (project.status === "submitted") {
      setFlash(res, "error", "Withdraw the open review before archiving this project.");
      return res.redirect(`/app/projects/${project.id}`);
    }
    project.status = "archived";
    project.updatedAt = nowIso();
    await store.put("project", project.id, project);
    setFlash(res, "success", `${project.title} was archived.`);
    res.redirect("/app/projects");
  });

  router.post("/:id/funding/submit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    if (project.track !== "hardware") {
      setFlash(res, "error", "Only electronics hardware projects use the funding request flow.");
      return res.redirect(`/app/projects/${project.id}`);
    }
    if (["funding_submitted", "funding_approved", "funding_issued"].includes(project.status)) {
      setFlash(res, "error", "This project already has a funding request in progress or issued.");
      return res.redirect(`/app/projects/${project.id}#funding`);
    }
    const input = projectInput({ ...formValues(project), ...req.body, track: "hardware" });
    const errors = validateFundingRequest(input);
    if (errors.length) {
      setFlash(res, "error", errors[0]);
      return res.redirect(`/app/projects/${project.id}#funding`);
    }
    const timestamp = nowIso();
    const designJournals = await store.list("journal");
    const designMinutes = designJournals.filter((journal) => journal.projectId === project.id).reduce((sum, journal) => sum + (Number(journal.minutes) || 0), 0);
    // Older projects may predate design-minute logging; preserve their submitted
    // estimate for migration while new projects should document design time.
    const fundingMinutes = designMinutes > 0 ? designMinutes : Math.round(input.estimatedHours * 60);
    const request = {
      id: randomId("fund_"), projectId: project.id, userId: req.user.id,
      status: "submitted", estimatedHours: input.estimatedHours,
      requestedHertz: Math.round((fundingMinutes * 5 / 60) * 100) / 100,
      designMinutes: fundingMinutes,
      buildPlan: input.buildPlan, bom: input.bom, bomItems: input.bomItems, designUrl: input.designUrl, testPlan: input.testPlan,
      projectSnapshot: structuredClone({ ...project, ...toProjectRecord(project.id, project.userId, input, project) }),
      reviewerId: null, reviewerName: null, review: null, issuedAt: null, issuedById: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await store.withLock(`funding:${project.id}`, async () => {
      await store.put("funding_request", request.id, request);
      await store.put("project", project.id, { ...project, ...toProjectRecord(project.id, project.userId, input, project), status: "funding_submitted", updatedAt: timestamp });
    });
    await writeAudit(store, req.user, {
      action: "funding.submitted", entityType: "funding_request", entityId: request.id,
      summary: `Submitted a $${request.requestedHertz} hardware funding request for ${project.title}.`, after: request,
    });
    await notifier.fundingSubmitted?.(req.user, project, request);
    setFlash(res, "success", "Funding request sent! The CQ team will review your design and build plan.");
    res.redirect(`/app/projects/${project.id}#funding`);
  });

  router.post("/:id/submit", requireCsrf, async (req, res) => {
    const project = await ownedProject(store, req.params.id, req.user.id);
    if (!project) return res.sendStatus(404);
    const programSettings = await store.get("setting", "program");
    if (programSettings?.submissionsClosed && !hasPermission(req.user, "users.manage")) {
      setFlash(res, "error", programSettings.submissionsMessage || "Project submissions are temporarily closed.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    const projectDetails = await details(store, project.id);
    if (project.status === "rejected") {
      setFlash(res, "error", "A denied project cannot be resubmitted unless an organizer reopens it.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    if (project.status === "submitted") {
      setFlash(res, "error", "This project already has an open review.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    if (project.track === "hardware" && project.status !== "funding_issued") {
      setFlash(res, "error", "Send your design and funding request first. You can ship the finished hardware project after funding is issued.");
      return res.redirect(`/app/projects/${project.id}#funding`);
    }
    const journalsForSubmission = submissionJournals(projectDetails.journals, projectDetails.submissions);
    const state = readiness(project, journalsForSubmission, req.user, { hasPriorSubmission: projectDetails.submissions.length > 0 });
    if (state.errors.length) {
      setFlash(res, "error", state.errors[0]);
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
    const country = await store.get("country", project.countryCode);
    const payload = buildAriPayload({ project, user: req.user, journals: journalsForSubmission, config, country });
    const timestamp = nowIso();
    const usingAri = ariClient.configured();
    const submission = {
      id: randomId("ship_"),
      projectId: project.id,
      externalId: project.id,
      ariId: null,
      payload,
      projectSnapshot: structuredClone(project),
      journalSnapshots: structuredClone(journalsForSubmission),
      phase: usingAri ? "processing" : "review",
      decision: null,
      event: null,
      review: null,
      journalIds: journalsForSubmission.map((journal) => journal.id),
      attemptCount: 1,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      airtableFields: {
        "Code URL": project.repoUrl || "",
        "Demo URL": project.demoUrl || "",
        "First Name": req.user.firstName || "",
        "Last Name": req.user.lastName || "",
        Email: req.user.email || "",
        "Project banner": project.thumbnailUrl || "",
        Description: project.description || "",
        "GitHub Username": githubUsername(project.repoUrl),
        "Address line 1": req.user.addressLine1 || "",
        "Address line 2": req.user.addressLine2 || "",
        City: req.user.city || "",
        "state/province": req.user.region || "",
        "Country(2 letter code)": country?.code || project.countryCode || "",
        "Zip/Postal code": req.user.postalCode || "",
        Birthday: formatBirthday(req.user.birthday),
        "Override Hours Spent": "",
        "Override hours spent justification": "",
        "Claimed Hours": (journalsForSubmission.reduce((sum, journal) => sum + (Number(journal.minutes) || 0), 0) / 60).toFixed(2),
        "Approved Hours": "",
        "Project Type": project.track || project.projectType || "",
        "Submission ID": "",
        "Review Status": "Submitted",
      },
    };
    submission.airtableFields["Submission ID"] = submission.id;
    await store.put("submission", submission.id, submission);
    if (!usingAri) {
      project.status = "submitted";
      project.updatedAt = nowIso();
      await store.put("project", project.id, project);
      await writeAudit(store, req.user, {
        action: "project.shipped", entityType: "submission", entityId: submission.id,
        summary: `Shipped ${project.title} to the local review queue.`, after: submission,
        metadata: { projectId: project.id, reviewMode: "local" },
      });
      await notifier.projectSubmitted(req.user, project);
      setFlash(res, "success", "Project shipped! The CQ team will check it out soon.");
      return res.redirect(`/app/projects/${project.id}#submission`);
    }
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
      await writeAudit(store, req.user, {
        action: "project.shipped", entityType: "submission", entityId: submission.id,
        summary: `Shipped ${project.title}.`, after: submission, metadata: { projectId: project.id },
      });
      await notifier.projectSubmitted(req.user, project);
      setFlash(res, "success", result.status === 200 ? "This exact version was already queued." : "Project shipped! The CQ team will check it out soon.");
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
    if (!ariClient.configured() || !submission.ariId) {
      setFlash(res, "success", "Your latest review status is already up to date.");
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
      if (ariClient.configured()) {
        const result = await ariClient.withdraw(project.id);
        if (!result.ok) throw new Error(result.body?.message || result.body?.error || `The review service returned ${result.status}`);
      }
      const submissions = await store.list("submission");
      await Promise.all(submissions
        .filter((item) => item.projectId === project.id && !item.decision)
        .map((item) => store.put("submission", item.id, { ...item, phase: "withdrawn", updatedAt: nowIso() })));
      project.status = "building";
      project.updatedAt = nowIso();
      await store.put("project", project.id, project);
      await writeAudit(store, req.user, {
        action: "project.withdrawn", entityType: "project", entityId: project.id,
        summary: `Withdrew the open submission for ${project.title}.`, after: project,
      });
      setFlash(res, "success", "The open review submission was withdrawn.");
    } catch (error) {
      req.app.locals.logger.error("Ari withdrawal failed", error);
      setFlash(res, "error", "The review submission could not be withdrawn. It may already have a decision.");
    }
    res.redirect(`/app/projects/${project.id}#submission`);
  });

  return router;
}
