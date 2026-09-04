import { Router, raw } from "express";
import { applyAriEvent, verifyAriDelivery } from "../ari.js";

export function ariWebhookRoutes({ store, config, notifier }) {
  const router = Router();

  router.post("/", raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const timestamp = req.get("x-ari-timestamp") || "";
    const deliveryId = req.get("x-ari-delivery-id") || "";
    const signature = req.get("x-ari-signature") || "";

    if (
      !verifyAriDelivery({
        rawBody,
        timestamp,
        deliveryId,
        signature,
        secret: config.ariWebhookSecret,
      })
    ) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
    if (!payload.event || !payload.external_id) return res.status(422).json({ error: "invalid_payload" });

    const result = await applyAriEvent(store, payload, deliveryId);
    if (!result.handled) return res.status(404).json({ error: result.reason });
    if (!result.duplicate && result.userId && result.projectId) {
      const [user, project] = await Promise.all([
        store.get("user", result.userId),
        store.get("project", result.projectId),
      ]);
      if (user && project) await notifier.projectDecision(user, project, result.event, payload.review ?? {});
    }
    return res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate) });
  });

  return router;
}
