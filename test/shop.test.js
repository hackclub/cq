import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1];
}

test("checkout rejects a cart when product stock is unavailable", async () => {
  const config = getConfig({
    nodeEnv: "development",
    baseUrl: "http://localhost:3000",
    devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Maker", email: "maker@example.com", return_to: "/app/shop" });

  const product = await store.get("product", "yagi-kit");
  await store.put("product", product.id, { ...product, stock: 0 });
  const shop = await agent.get("/app/shop");
  await agent.post("/app/shop/cart/yagi-kit").type("form").send({ _csrf: csrf(shop.text), quantity: 1 });
  const cart = await agent.get("/app/shop/cart");
  const checkout = await agent.post("/app/shop/checkout").type("form").send({
    _csrf: csrf(cart.text),
    shipping_name: "Maker",
    address_line_1: "1 Test Road",
    city: "Hobart",
    region: "Tasmania",
    postal_code: "7000",
    country_code: "AU",
  });

  assert.equal(checkout.status, 422);
  assert.match(checkout.text, /only has 0 available/);
  assert.equal((await store.list("order")).length, 0);
  assert.equal((await store.get("product", "yagi-kit")).stock, 0);
  assert.equal((await store.list("user"))[0].hertz, 200);
});
