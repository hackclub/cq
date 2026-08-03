import { Router } from "express";
import { requireAuth, requireCsrf } from "../auth.js";
import { safeReturnTo, setFlash } from "../utils.js";

export function hackatimeRoutes({ client, logger }) {
  const router = Router();
  router.use(requireAuth);

  router.get("/connect", async (req, res) => {
    const returnTo = safeReturnTo(req.query.return_to, "/app/profile");
    if (!client.configured()) {
      setFlash(res, "error", "Hackatime connection is not configured yet.");
      return res.redirect(returnTo);
    }
    try {
      return res.redirect(await client.startConnection(req.user.id, returnTo));
    } catch (error) {
      logger.error("Could not start Hackatime OAuth", error);
      setFlash(res, "error", "Could not start the Hackatime connection. Please try again.");
      return res.redirect(returnTo);
    }
  });

  router.get("/callback", async (req, res) => {
    if (req.query.error) {
      setFlash(res, "error", "Hackatime connection was cancelled.");
      return res.redirect("/app/profile");
    }
    try {
      const result = await client.finishConnection({
        userId: req.user.id,
        state: req.query.state,
        code: req.query.code,
      });
      setFlash(res, "success", "Hackatime connected. Your coding projects are ready to select.");
      return res.redirect(safeReturnTo(result.returnTo, "/app/profile"));
    } catch (error) {
      logger.error("Hackatime OAuth callback failed", error);
      setFlash(res, "error", "Could not connect Hackatime. Please start the connection again.");
      return res.redirect("/app/profile");
    }
  });

  router.post("/refresh", requireCsrf, async (req, res) => {
    const returnTo = safeReturnTo(req.body.return_to, "/app/profile");
    const result = await client.projects(req.user.id, { force: true });
    setFlash(
      res,
      result.error ? "error" : "success",
      result.error ? "Could not refresh your Hackatime projects right now." : "Hackatime projects refreshed.",
    );
    res.redirect(returnTo);
  });

  router.post("/disconnect", requireCsrf, async (req, res) => {
    await client.disconnect(req.user.id);
    setFlash(res, "success", "Hackatime disconnected from CQ.");
    res.redirect("/app/profile");
  });

  return router;
}
