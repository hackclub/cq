import { Router } from "express";
import { authConfigured, startOAuth } from "../auth.js";

const CQ_NPS_FORM = "https://forms.hackclub.com/ysws-cq-nps";

export function cqNpsUrl(slackId) {
  const url = new URL(CQ_NPS_FORM);
  url.searchParams.set("slackid", String(slackId || "").trim());
  return url.toString();
}

export function publicRoutes({ store, config }) {
  const router = Router();

  router.get("/api/cq-nps", async (req, res) => {
    if (req.user?.slackId) return res.redirect(cqNpsUrl(req.user.slackId));
    if (!authConfigured(config)) return res.status(503).type("text/plain").send("CQ sign-in is unavailable.");
    const authUrl = await startOAuth(store, config, "/api/cq-nps", {
      scopes: ["openid", "slack_id"],
      purpose: "cq_nps",
    });
    return res.redirect(authUrl);
  });

  router.get("/", async (req, res) => {
    const launchGate = await store.get("setting", "launch_gate");
    res.render("landing", {
      title: "CQ — get on the air",
      bodyClass: "landing-page",
      launchGate: launchGate?.enabled === true ? launchGate : null,
    });
  });

  router.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  return router;
}
