import { Router } from "express";
import {
  authConfigured,
  consumeOAuthState,
  createSession,
  destroySession,
  exchangeHackClubCode,
  startOAuth,
  upsertUser,
  requireCsrf,
  userRoles,
} from "../auth.js";
import { nowIso, randomId, safeReturnTo, setFlash } from "../utils.js";

export function authRoutes({ store, config }) {
  const router = Router();

  router.get("/login", async (req, res) => {
    const returnTo = safeReturnTo(req.query.return_to);
    if (req.user) return res.redirect(returnTo);
    if (authConfigured(config)) return res.redirect(await startOAuth(store, config, returnTo));
    res.status(503).render("auth/setup", {
      title: "Sign in setup",
      returnTo,
      devAuthBypass: config.devAuthBypass,
    });
  });

  router.get("/callback", async (req, res) => {
    if (req.query.error) {
      return res.status(400).render("error", {
        title: "Sign in cancelled",
        message: String(req.query.error_description || req.query.error),
      });
    }
    const oauthState = await consumeOAuthState(store, req.query.state);
    if (!oauthState || !req.query.code) {
      return res.status(400).render("error", {
        title: "Sign in expired",
        message: "Please start the Hack Club sign-in again.",
      });
    }
    try {
      const profile = await exchangeHackClubCode(config, String(req.query.code), oauthState);
      const user = await upsertUser(store, config, profile);
      await createSession(store, config, res, user.id);
      setFlash(res, "success", `Welcome to CQ, ${user.name}.`);
      res.redirect(safeReturnTo(oauthState.return_to));
    } catch (error) {
      req.app.locals.logger.error("Hack Club Auth callback failed", error);
      res.status(502).render("error", {
        title: "Could not sign you in",
        message: "Hack Club Auth did not complete successfully. Please try again.",
      });
    }
  });

  router.post("/logout", requireCsrf, async (req, res) => {
    await destroySession(store, config, req, res);
    res.redirect("/");
  });

  router.post("/dev-login", async (req, res) => {
    if (!config.devAuthBypass) return res.sendStatus(404);
    const timestamp = nowIso();
    const email = String(req.body.email || "radio-maker@example.com").trim().toLowerCase();
    const name = String(req.body.name || "Radio Maker").trim().slice(0, 100);
    const users = await store.list("user");
    const existing = users.find((user) => user.email === email);
    const id = existing?.id ?? randomId("user_");
    const roles = config.adminEmails.includes(email)
      ? ["participant", "admin"]
      : [...new Set(["participant", ...userRoles(existing || {}).filter((role) => role !== "participant")])];
    await store.put("user", id, {
      id,
      hackClubId: existing?.hackClubId ?? `dev!${id}`,
      email,
      name,
      slackId: existing?.slackId ?? "UDEVLOCAL",
      verificationStatus: "verified",
      yswsEligible: true,
      hertz: existing?.hertz ?? 200,
      roles,
      role: roles.includes("admin") ? "admin" : "participant",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await createSession(store, config, res, id);
    res.redirect(safeReturnTo(req.body.return_to));
  });

  return router;
}
