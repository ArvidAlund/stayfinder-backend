import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app-context.js";
import { HttpError, fromDb } from "./errors.js";
import { requireAuth } from "./middleware.js";
import type { Property } from "./types.js";
import { validate } from "./validation.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use format YYYY-MM-DD");

const propertyInput = z.object({
  title: z.string().trim().min(1, "Title is required"),
  description: z.string().default(""),
  location: z.string().trim().min(1, "Location is required"),
  price_per_night: z.coerce.number().positive("Price must be greater than 0"),
  max_guests: z.coerce.number().int().positive("Guests must be at least 1"),
});

const listQuery = z
  .object({
    location: z.string().trim().optional(),
    max_price: z.coerce.number().positive().optional(),
    guests: z.coerce.number().int().positive().optional(),
    sort: z.enum(["price_asc", "price_desc"]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: "Both from and to are required",
    path: ["from"],
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: "from must be before to",
    path: ["to"],
  });

const idParam = z.object({ id: z.string().uuid() });

export const propertyRoutes = new Hono<AppEnv>()
  .get("/", validate("query", listQuery), async (c) => {
    const q = c.req.valid("query");
    const db = c.get("db");
    let query = db.from("properties").select("*");

    if (q.location) query = query.ilike("location", `%${q.location.replace(/[%_,]/g, " ")}%`);
    if (q.max_price) query = query.lte("price_per_night", q.max_price);
    if (q.guests) query = query.gte("max_guests", q.guests);
    if (q.from && q.to) {
      const { data: ids, error } = await db.rpc("available_property_ids", { p_from: q.from, p_to: q.to });
      if (error) throw fromDb(error);
      query = query.in("id", ids as string[]);
    }
    // G8: sorting happens in the database
    query = q.sort ? query.order("price_per_night", { ascending: q.sort === "price_asc" }) : query.order("created_at", { ascending: false });

    const { data, error } = await query;
    if (error) throw fromDb(error);
    return c.json(data as Property[]);
  })
  .get("/:id", validate("param", idParam), async (c) => {
    const { data, error } = await c.get("db").from("properties").select("*").eq("id", c.req.valid("param").id).maybeSingle();
    if (error) throw fromDb(error);
    if (!data) throw new HttpError(404, "Property not found", "NOT_FOUND");
    return c.json(data as Property);
  })
  .post("/", requireAuth, validate("json", propertyInput), async (c) => {
    // owner_id is never read from the body: the column default is auth.uid() and RLS checks it
    const { data, error } = await c.get("db").from("properties").insert(c.req.valid("json")).select().single();
    if (error) throw fromDb(error);
    return c.json(data as Property, 201);
  })
  .patch("/:id", requireAuth, validate("param", idParam), validate("json", propertyInput.partial()), async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const { data, error } = await db.from("properties").update(c.req.valid("json")).eq("id", id).select().maybeSingle();
    if (error) throw fromDb(error);
    if (!data) await missingOrForbidden(c.get("db"), id);
    return c.json(data as Property);
  })
  .delete("/:id", requireAuth, validate("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c.get("db").from("properties").delete().eq("id", id).select().maybeSingle();
    if (error) throw fromDb(error);
    if (!data) await missingOrForbidden(c.get("db"), id);
    return c.body(null, 204);
  });

/** RLS makes a foreign row look like "0 rows updated". Properties are public, so we can tell 404 from 403. */
async function missingOrForbidden(db: AppEnv["Variables"]["db"], id: string): Promise<never> {
  const { data } = await db.from("properties").select("id").eq("id", id).maybeSingle();
  throw data ? new HttpError(403, "You do not own this property", "FORBIDDEN") : new HttpError(404, "Property not found", "NOT_FOUND");
}
