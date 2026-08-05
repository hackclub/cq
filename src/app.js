import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import helmet from "helmet";
import { createAriClient } from "./ari.js";
import { sessionMiddleware } from "./auth.js";
import { createHackatimeClient } from "./hackatime.js";
import { adminRoutes } from "./routes/admin.js";
import { ariWebhookRoutes } from "./routes/ari-webhook.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { hackatimeRoutes } from "./routes/hackatime.js";
import { projectRoutes } from "./routes/projects.js";
import { publicRoutes } from "./routes/public.js";
import { shopRoutes } from "./routes/shop.js";
import { seedStore } from "./seed.js";
import { createSlackNotifier } from "./slack.js";
import { createStore } from "./store.js";
import { formatDate, formatDateTime, jsonArray, readFlash, statusLabel } from "./utils.js";

const consoleLogger = {
  info: (...args) => console.info(...args),
  error: (...args) => console.error(...args),
};

const require = createRequire(import.meta.url);
const spaceMonoFilesPath = path.dirname(
  require.resolve("@fontsource/space-mono/files/space-mono-latin-400-normal.woff2"),
);

export async function createApp({
  config, store = null, ariClient = null, hackatimeClient = null, slackNotifier = null, logger = consoleLogger, storeOptions = {},
} = {}) {
  if (!config) throw new Error("createApp requires config");
  const dataStore = store ?? await createStore(config, storeOptions);
  await seedStore(dataStore);
  const ari = ariClient ?? createAriClient(config);
  const hackatime = hackatimeClient ?? createHackatimeClient(config, dataStore);
  const notifier = slackNotifier ?? createSlackNotifier(config, dataStore);
  const app = express();

  app.locals.config = config;
  app.locals.store = dataStore;
  app.locals.ariClient = ari;
  app.locals.hackatimeClient = hackatime;
  app.locals.slackNotifier = notifier;
  app.locals.logger = logger;
  app.locals.jsonArray = jsonArray;
  app.locals.formatDate = formatDate;
  app.locals.formatDateTime = formatDateTime;
  app.locals.statusLabel = statusLabel;

  app.set("view engine", "ejs");
  app.set("views", path.join(config.projectRoot, "views"));
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "https:"],
          "media-src": ["'self'", "https:"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "font-src": ["'self'", "data:"],
          "script-src": ["'self'"],
        },
      },
    }),
  );
  app.use("/ari/webhook", ariWebhookRoutes({ store: dataStore, config, notifier }));
  app.use(express.urlencoded({ extended: false, limit: "128kb" }));
  app.use("/fonts/space-mono", express.static(
    spaceMonoFilesPath,
    { maxAge: config.isProduction ? "1y" : 0, immutable: config.isProduction },
  ));
  app.use(express.static(path.join(config.projectRoot, "public"), { maxAge: config.isProduction ? "1d" : 0 }));
  app.use(sessionMiddleware(dataStore, config));
  app.use(async (req, res, next) => {
    try {
      res.locals.currentPath = req.path;
      res.locals.flash = readFlash(req, res);
      res.locals.cartCount = req.user
        ? (await dataStore.list("cart")).filter((item) => item.userId === req.user.id).reduce((sum, item) => sum + item.quantity, 0)
        : 0;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use("/", publicRoutes());
  app.use("/auth", authRoutes({ store: dataStore, config }));
  app.use("/app/hackatime", hackatimeRoutes({ client: hackatime, logger }));
  app.use("/app", dashboardRoutes({ store: dataStore, hackatimeClient: hackatime }));
  app.use("/app/projects", projectRoutes({ store: dataStore, config, ariClient: ari, hackatimeClient: hackatime, notifier }));
  app.use("/app/shop", shopRoutes({ store: dataStore, notifier }));
  app.use("/admin", adminRoutes({ store: dataStore, config, ariClient: ari, hackatimeClient: hackatime, notifier }));

  app.use((req, res) => {
    res.status(404).render("error", { title: "Signal lost", message: "That page is not on this frequency." });
  });

  app.use((error, req, res, next) => {
    logger.error("Unhandled request error", error);
    if (res.headersSent) return next(error);
    res.status(500).render("error", {
      title: "Something went off frequency",
      message: config.isProduction ? "Please try again in a moment." : error.message,
    });
  });

  return app;
}
