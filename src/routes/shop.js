import { Router } from "express";
import { writeAudit } from "../audit.js";
import { requireAuth, requireCsrf } from "../auth.js";
import { nowIso, randomId, setFlash } from "../utils.js";
import { checkoutInput, validateCheckout } from "../validation.js";

async function getCart(store, userId) {
  const [cartItems, products] = await Promise.all([store.list("cart"), store.list("product")]);
  const items = cartItems
    .filter((item) => item.userId === userId)
    .map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId && candidate.active);
      return product ? { ...product, quantity: item.quantity, lineTotal: product.price * item.quantity } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return { items, total: items.reduce((sum, item) => sum + item.lineTotal, 0) };
}

async function activeCountries(store) {
  return (await store.list("country"))
    .filter((country) => country.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function shopRoutes({ store, notifier }) {
  const router = Router();
  router.use(requireAuth);
  router.use(async (req, res, next) => {
    const settings = await store.get("setting", "program");
    if (settings?.shopClosed && !req.path.startsWith("/orders")) {
      setFlash(res, "error", settings.shopMessage || "The CQ shop is temporarily closed.");
      return res.redirect("/app");
    }
    next();
  });

  router.get("/", async (req, res) => {
    const products = (await store.list("product")).filter((product) => product.active).sort((a, b) => a.sortOrder - b.sortOrder);
    res.render("shop/index", { title: "CQ shop", products });
  });

  router.post("/cart/:productId", requireCsrf, async (req, res) => {
    const product = await store.get("product", req.params.productId);
    if (!product?.active) return res.sendStatus(404);
    const id = `${req.user.id}_${product.id}`;
    const current = await store.get("cart", id);
    const requested = Math.max(1, Math.min(10, Number.parseInt(req.body.quantity || "1", 10) || 1));
    const quantity = Math.min(10, (current?.quantity ?? 0) + requested);
    await store.put("cart", id, { id, userId: req.user.id, productId: product.id, quantity });
    setFlash(res, "success", `${product.name} added to your cart.`);
    res.redirect(req.get("referer")?.includes("/app/shop/cart") ? "/app/shop/cart" : "/app/shop");
  });

  router.get("/cart", async (req, res) => {
    const countries = await activeCountries(store);
    res.render("shop/cart", {
      title: "Your cart",
      cart: await getCart(store, req.user.id),
      errors: [],
      values: {
        shipping_name: [req.user.firstName, req.user.lastName].filter(Boolean).join(" ") || req.user.name,
        address_line_1: req.user.addressLine1 || "",
        address_line_2: req.user.addressLine2 || "",
        city: req.user.city || "",
        region: req.user.region || "",
        postal_code: req.user.postalCode || "",
      },
      countries,
    });
  });

  router.post("/cart/:productId/update", requireCsrf, async (req, res) => {
    const id = `${req.user.id}_${req.params.productId}`;
    const product = await store.get("product", req.params.productId);
    if (!product) return res.sendStatus(404);
    const quantity = Number.parseInt(req.body.quantity, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) await store.delete("cart", id);
    else await store.put("cart", id, { id, userId: req.user.id, productId: product.id, quantity: Math.min(10, quantity) });
    res.redirect("/app/shop/cart");
  });

  router.post("/checkout", requireCsrf, async (req, res) => {
    const input = checkoutInput(req.body);
    const currentCart = await getCart(store, req.user.id);
    const errors = validateCheckout(input);
    const countries = await activeCountries(store);
    const countryPolicy = countries.find((country) => country.code === input.countryCode);
    if (!countryPolicy) errors.push("Choose a supported country or territory.");
    if (countryPolicy?.fulfilmentMode === "restricted") {
      errors.push(`This item cannot currently be fulfilled to ${countryPolicy.name}.`);
    }
    if (!currentCart.items.length) errors.push("Your cart is empty.");
    if (currentCart.total > req.user.hertz) errors.push("You do not have enough hertz for this order.");
    currentCart.items.forEach((item) => {
    });
    if (errors.length) {
      return res.status(422).render("shop/cart", {
        title: "Your cart", cart: currentCart, errors, values: req.body, countries,
      });
    }

    try {
      const order = await store.withLock("checkout", async () => {
        const user = await store.get("user", req.user.id);
        const freshCart = await getCart(store, user.id);
        if (!freshCart.items.length || freshCart.total > user.hertz) throw new Error("Your cart or balance changed.");
        const timestamp = nowIso();
        const id = randomId("order_");
        const order = {
          id,
          userId: user.id,
          status: "received",
          total: freshCart.total,
          shipping: {
            ...input,
            country: countryPolicy.name,
            countryPolicy: {
              code: countryPolicy.code,
              fulfilmentMode: countryPolicy.fulfilmentMode,
              fulfilmentNote: countryPolicy.fulfilmentNote,
            },
          },
          items: freshCart.items.map((item) => ({
            productId: item.id,
            name: item.name,
            unitPrice: item.price,
            quantity: item.quantity,
          })),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const freshProducts = await Promise.all(freshCart.items.map((item) => store.get("product", item.id)));
        freshCart.items.forEach((item, index) => {
          const product = freshProducts[index];
          if (product.stock < item.quantity) throw new Error(`${product.name} is no longer available in that quantity.`);
        });
        for (let index = 0; index < freshCart.items.length; index += 1) {
          const item = freshCart.items[index];
          const product = freshProducts[index];
        }
        user.hertz = Math.max(0, Math.round((Number(user.hertz) - freshCart.total) * 100) / 100);
        user.updatedAt = timestamp;
        await store.put("user", user.id, user);
        await store.put("order", id, order);
        const cartItems = await store.list("cart");
        await Promise.all(cartItems.filter((item) => item.userId === user.id).map((item) => store.delete("cart", item.id)));
        return order;
      });
      const freshUser = await store.get("user", req.user.id);
      await writeAudit(store, freshUser, {
        action: "order.placed", entityType: "order", entityId: order.id,
        summary: `Placed order ${order.id} for ${order.total} hertz.`, after: order,
      });
      await Promise.all([
        notifier.orderPurchased(freshUser, order),
        notifier.adminPurchase(freshUser, order),
      ]);
      setFlash(res, "success", "Order received. The CQ team can now fulfil it.");
      res.redirect(`/app/shop/orders/${order.id}`);
    } catch (error) {
      req.app.locals.logger.error("Checkout failed", error);
      setFlash(res, "error", error.message || "Checkout could not be completed.");
      res.redirect("/app/shop/cart");
    }
  });

  router.get("/orders", async (req, res) => {
    const orders = (await store.list("order"))
      .filter((order) => order.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.render("shop/orders", { title: "Your orders", orders, order: null, items: [] });
  });

  router.get("/orders/:id", async (req, res) => {
    const order = await store.get("order", req.params.id);
    if (!order || order.userId !== req.user.id) return res.sendStatus(404);
    res.render("shop/orders", { title: `Order ${order.id}`, orders: [], order, items: order.items });
  });

  return router;
}
