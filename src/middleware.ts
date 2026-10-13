import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { env } from "./env.js";
import { HttpError } from "./errors.js";
import { clientFor } from "./supabase.js";
import type { AppEnv } from "./app-context.js";

const ACCESS = "sb-access-token";
const REFRESH = "sb-refresh-token";
const cookieOpts = {
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env.secureCookies,
  path: "/",
};

export function setSession(c: Context, access: string, refresh: string) {
  setCookie(c, ACCESS, access, { ...cookieOpts, maxAge: 60 * 60 });
  setCookie(c, REFRESH, refresh, { ...cookieOpts, maxAge: 60 * 60 * 24 * 30 });
}

export function clearSession(c: Context) {
  deleteCookie(c, ACCESS, { path: "/" });
  deleteCookie(c, REFRESH, { path: "/" });
}

/** Authentication: resolve the cookie session into c.var.user and a per-user DB client. */
export const session = createMiddleware<AppEnv>(async (c, next) => {
  let access = getCookie(c, ACCESS);
  const refresh = getCookie(c, REFRESH);
  let user: AppEnv["Variables"]["user"] = null;

  if (access) {
    const { data } = await clientFor().auth.getUser(access);
    if (data.user) user = { id: data.user.id, email: data.user.email ?? "" };
  }
  if (!user && refresh) {
    const { data } = await clientFor().auth.refreshSession({ refresh_token: refresh });
    if (data.session && data.user) {
      access = data.session.access_token;
      setSession(c, access, data.session.refresh_token);
      user = { id: data.user.id, email: data.user.email ?? "" };
    } else {
      clearSession(c);
    }
  }

  c.set("user", user);
  c.set("db", clientFor(user ? access : undefined));
  await next();
});

/** Authorization gate: 401 when nobody is logged in. Fine-grained rules live in RLS/triggers. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) throw new HttpError(401, "You must be logged in", "UNAUTHENTICATED");
  await next();
});
