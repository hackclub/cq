import crypto from "node:crypto";
import { nowIso, publicUrl } from "./utils.js";

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function signAriBody(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyAriDelivery({ rawBody, timestamp, deliveryId, signature, secret, now = Date.now() }) {
  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp * 1000) > 5 * 60_000) return false;
  if (!deliveryId || !secret) return false;
  const signedPayload = `${timestamp}.${deliveryId}.${rawBody}`;
  return safeEqualHex(signAriBody(signedPayload, secret), signature);
}

export function buildAriPayload({ project, user, journals, config, country = null }) {
  const payload = {
    external_id: project.id,
    title: project.title,
    description: project.description,
    maker: {
      email: user.email,
      name: user.name,
      slack_id: user.slackId,
    },
    repo_url: project.repoUrl,
    track: project.track,
    thumbnail_url: project.thumbnailUrl,
    hackatime_projects: project.hackatimeProjects,
    evidence: project.evidence,
    meta: {
      "CQ project": publicUrl(config, `/app/projects/${project.id}`),
      "Project type": project.projectType,
      "Ham radio relevance": project.radioRelevance,
      Country: country?.name || project.countryCode || "Not set",
      "Licence goal": project.licenseGoal || "Not set",
      Callsign: project.callsign || "Not issued yet",
    },
  };
  if (project.demoUrl) payload.demo_url = project.demoUrl;
  if (journals.length) {
    payload.journals = journals.map((journal) => ({
      at: journal.entryDate,
      minutes: journal.minutes,
      text: journal.text,
    }));
  }
  if (project.isUpdate || project.updateMessage) {
    payload.is_update = true;
    payload.update_message = project.updateMessage;
  }
  if (project.aiStatement) payload.meta["AI statement"] = project.aiStatement;
  return payload;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return { body: text ? JSON.parse(text) : {}, text };
  } catch {
    return { body: {}, text };
  }
}

export function createAriClient(config, fetchImpl = fetch) {
  const base = "https://webhooks.ari.hackclub.com/api/ingest";
  const configured = () => Boolean(config.ariProgramId && config.ariSigningSecret);

  return {
    configured,
    async submit(payload) {
      if (!configured()) throw new Error("Ari has not been configured yet.");
      const rawBody = JSON.stringify(payload);
      const response = await fetchImpl(`${base}/${encodeURIComponent(config.ariProgramId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ari-Signature": signAriBody(rawBody, config.ariSigningSecret),
        },
        body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });
      const parsed = await readResponse(response);
      return { ok: response.status >= 200 && response.status < 300, status: response.status, ...parsed };
    },
    async status({ externalId, ariId }) {
      if (!configured()) throw new Error("Ari has not been configured yet.");
      const url = new URL(`${base}/${encodeURIComponent(config.ariProgramId)}/status`);
      if (ariId) url.searchParams.set("id", ariId);
      else url.searchParams.set("external_id", externalId);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.ariSigningSecret}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const parsed = await readResponse(response);
      return { ok: response.ok, status: response.status, ...parsed };
    },
    async withdraw(externalId) {
      if (!configured()) throw new Error("Ari has not been configured yet.");
      const rawBody = JSON.stringify({ external_id: externalId });
      const response = await fetchImpl(`${base}/${encodeURIComponent(config.ariProgramId)}/withdraw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ari-Signature": signAriBody(rawBody, config.ariSigningSecret),
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      const parsed = await readResponse(response);
      return { ok: response.ok, status: response.status, ...parsed };
    },
  };
}

export async function applyAriEvent(store, payload, deliveryId) {
  const timestamp = nowIso();
  const event = String(payload.event ?? "");
  const submissions = await store.list("submission");
  const submission = submissions
    .filter((item) => item.externalId === payload.external_id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!submission) return { handled: false, reason: "unknown_external_id" };
  return store.withLock(`ari:${submission.id}`, async () => {
    const duplicate = await store.get("delivery", deliveryId);
    if (duplicate) return { handled: true, duplicate: true };
    await store.put("delivery", deliveryId, { id: deliveryId, event, payload, receivedAt: timestamp });
    const phase =
      event === "review.requeued" ? "review" :
      event === "review.reverted" ? "reverted" :
      event.startsWith("review.") && event !== "review.fraud" ? "reviewed" :
      submission.phase;
    submission.ariId = payload.id ?? submission.ariId;
    submission.phase = phase;
    submission.decision = payload.decision ?? null;
    submission.event = event;
    submission.review = payload.review ?? payload.fraud ?? {};
    submission.lastError = null;
    submission.updatedAt = timestamp;
    await store.put("submission", submission.id, submission);

    const projectStatus = {
      "review.approved": "approved",
      "review.changes": "needs_changes",
      "review.rejected": "rejected",
      "review.reverted": "building",
      "review.requeued": "submitted",
    }[event];
    const project = await store.get("project", submission.projectId);
    if (projectStatus && project) {
      project.status = projectStatus;
      project.updatedAt = timestamp;
      await store.put("project", project.id, project);
    }

    if (event === "review.approved") {
      const approvedMinutes = Math.max(0, Number(payload.review?.approved_minutes ?? 0));
      const hertz = Math.round(((approvedMinutes * 5) / 60) * 100) / 100;
      const ledger = await store.get("ledger", submission.id);
      if (!ledger && project) {
        const user = await store.get("user", project.userId);
        user.hertz += hertz;
        user.updatedAt = timestamp;
        await store.put("user", user.id, user);
        await store.put("ledger", submission.id, {
          id: submission.id,
          userId: user.id,
          submissionId: submission.id,
          delta: hertz,
          reason: `Ari approval ${payload.id ?? submission.externalId}`,
          createdAt: timestamp,
        });
      }
    }

    if (["review.reverted", "review.requeued"].includes(event)) {
      const ledger = await store.get("ledger", submission.id);
      if (ledger) {
        const user = await store.get("user", ledger.userId);
        user.hertz = Math.max(0, user.hertz - Math.max(0, ledger.delta));
        user.updatedAt = timestamp;
        await store.put("user", user.id, user);
        await store.delete("ledger", submission.id);
      }
    }
    return {
      handled: true,
      duplicate: false,
      event,
      projectId: project?.id ?? null,
      userId: project?.userId ?? null,
    };
  });
}
