import { Router } from "express";

export function publicRoutes() {
  const router = Router();

  router.get("/", (req, res) => {
    res.render("landing", {
      title: "CQ — get on the air",
      bodyClass: "landing-page",
    });
  });

  router.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  return router;
}
