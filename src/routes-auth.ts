import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app-context.js";
import { HttpError } from "./errors.js";
import { clearSession, requireAuth, setSession } from "./middleware.js";
import { clientFor } from "./supabase.js";
import { validate } from "./validation.js";

const credentials = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const authRoutes = new Hono<AppEnv>()
  .post("/register", validate("json", credentials), async (c) => {
    const { email, password } = c.req.valid("json");
    const { data, error } = await clientFor().auth.signUp({ email, password });
    // Supabase hides existing users behind an empty identities list
    if (error?.code === "user_already_exists" || data.user?.identities?.length === 0)
      throw new HttpError(409, "Email already registered", "EMAIL_TAKEN");
    if (error || !data.user) throw new HttpError(400, error?.message ?? "Could not register");
    if (data.session) setSession(c, data.session.access_token, data.session.refresh_token);
    return c.json({ id: data.user.id, email: data.user.email }, 201);
  })
  .post("/login", validate("json", credentials), async (c) => {
    const { email, password } = c.req.valid("json");
    const { data, error } = await clientFor().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new HttpError(401, "Wrong email or password", "INVALID_CREDENTIALS");
    setSession(c, data.session.access_token, data.session.refresh_token);
    return c.json({ id: data.user.id, email: data.user.email });
  })
  .post("/logout", (c) => {
    clearSession(c);
    return c.body(null, 204);
  })
  // G2: the frontend asks this on every page load to learn who is logged in
  .get("/me", requireAuth, (c) => c.json(c.get("user")));
