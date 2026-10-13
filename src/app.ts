import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./app-context.js";
import { env } from "./env.js";
import { HttpError } from "./errors.js";
import { session } from "./middleware.js";
import { authRoutes } from "./routes-auth.js";
import { propertyRoutes } from "./routes-properties.js";
import { bookingRoutes } from "./routes-bookings.js";

export const app = new Hono<AppEnv>();

// credentials: true lets the browser send/receive the session cookie cross-origin
app.use("*", cors({ origin: env.frontendOrigin, credentials: true, allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));
app.use("*", session);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/properties", bookingRoutes.forProperty);
app.route("/properties", propertyRoutes);
app.route("/bookings", bookingRoutes.byId);

app.notFound((c) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404));
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code, details: err.details }, err.status);
  console.error(err);
  return c.json({ error: "Internal server error", code: "INTERNAL" }, 500);
});
