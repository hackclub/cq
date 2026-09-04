import { Router } from "express";

export function publicRoutes({ store }) {
  const router = Router();

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
