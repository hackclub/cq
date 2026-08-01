import { nowIso, randomId, publicUrl } from "./utils.js";

export function createSlackNotifier(config, store, fetchImpl = fetch) {
  const configured = () => Boolean(config.slackBotToken);

  async function post(channel, text) {
    if (!configured() || !channel) return { skipped: true };
    const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slackBotToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `Slack returned ${response.status}.`);
    return body;
  }

  async function deliver({ userId = null, channel, kind, text, entityId = null }) {
    const notification = {
      id: randomId("notice_"),
      userId,
      channel,
      kind,
      text,
      entityId,
      status: "pending",
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      const result = await post(channel, text);
      notification.status = result.skipped ? "skipped" : "sent";
      notification.slackTimestamp = result.ts ?? null;
    } catch (error) {
      notification.status = "failed";
      notification.error = error.message;
    }
    notification.updatedAt = nowIso();
    try {
      await store.put("notification", notification.id, notification);
    } catch {
      // A notification audit-write failure must not roll back the project or order event.
    }
    return notification;
  }

  async function userMessage(user, kind, text, entityId) {
    return deliver({ userId: user.id, channel: user.slackId, kind, text, entityId });
  }

  return {
    configured,
    projectSubmitted(user, project) {
      return userMessage(
        user,
        "project.submitted",
        `📡 *${project.title}* has been submitted for review. We’ll message you as it moves through the queue.\n${publicUrl(config, `/app/projects/${project.id}`)}`,
        project.id,
      );
    },
    projectUnderReview(user, project) {
      return userMessage(
        user,
        "project.under_review",
        `👀 *${project.title}* is now being reviewed. No action is needed unless the reviewer asks for changes.`,
        project.id,
      );
    },
    projectDecision(user, project, event, review = {}) {
      const messages = {
        "review.approved": `✅ *${project.title}* was approved! Open CQ to see the review and any hertz awarded for approved time.`,
        "review.changes": `🛠️ *${project.title}* was returned for changes.${review.note_to_maker ? `\n> ${review.note_to_maker}` : ""}`,
        "review.rejected": `⛔ *${project.title}* was denied.${review.note_to_maker ? `\n> ${review.note_to_maker}` : ""}`,
        "review.reverted": `↩️ The decision on *${project.title}* was reverted. Any reward from that decision has been removed while it is reconsidered.`,
        "review.requeued": `🔁 *${project.title}* is back in the review queue for a fresh look.`,
        "review.fraud": `🛡️ An additional integrity check finished for *${project.title}*. The CQ organizers will follow up if anything is needed.`,
      };
      return userMessage(user, event, messages[event] ?? `There is an update on *${project.title}*.`, project.id);
    },
    orderPurchased(user, order) {
      return userMessage(
        user,
        "order.purchased",
        `🛒 Order *${order.id}* was received for ${order.total} hertz. We’ll message you again when its fulfilment status changes.`,
        order.id,
      );
    },
    orderUpdated(user, order) {
      const tracking = order.trackingUrl ? `\nTrack it: ${order.trackingUrl}` : "";
      return userMessage(user, `order.${order.status}`, `📦 Order *${order.id}* is now *${order.status}*.${tracking}`, order.id);
    },
    adminPurchase(user, order) {
      if (!config.slackAdminChannelId) return Promise.resolve({ skipped: true });
      return deliver({
        channel: config.slackAdminChannelId,
        kind: "admin.order.purchased",
        text: `🛒 New CQ order *${order.id}* from ${user.name} (${user.email}) for ${order.total} hertz.\n${publicUrl(config, "/admin/orders")}`,
        entityId: order.id,
      });
    },
  };
}
