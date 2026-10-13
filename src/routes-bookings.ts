import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app-context.js";
import { HttpError, fromDb } from "./errors.js";
import { requireAuth } from "./middleware.js";
import type { Booking } from "./types.js";
import { validate } from "./validation.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use format YYYY-MM-DD");
const id = z.object({ id: z.string().uuid() });

// price/status/owner fields are deliberately absent: the client cannot set them (VG6, VG4)
const bookingFields = z.object({
  guest_email: z.string().email("Invalid email"),
  check_in: isoDate,
  check_out: isoDate,
  guests: z.coerce.number().int().positive("Guests must be at least 1"),
});
const datesOk = (b: { check_in?: string; check_out?: string }) =>
  !b.check_in || !b.check_out || b.check_in < b.check_out;
const datesMsg = { message: "Check-out must be after check-in", path: ["check_out"] };

const createBooking = bookingFields.refine(datesOk, datesMsg);
const updateBooking = bookingFields
  .partial()
  .extend({ status: z.enum(["confirmed", "cancelled"]).optional() })
  .refine(datesOk, datesMsg);

const forProperty = new Hono<AppEnv>()
  // RLS decides what comes back: guests see their own, the owner sees all
  .get("/:id/bookings", requireAuth, validate("param", id), async (c) => {
    const { data, error } = await c.get("db").from("bookings").select("*")
      .eq("property_id", c.req.valid("param").id).order("check_in");
    if (error) throw fromDb(error);
    return c.json(data as Booking[]);
  })
  .post("/:id/bookings", requireAuth, validate("param", id), validate("json", createBooking), async (c) => {
    const { data, error } = await c.get("db").from("bookings")
      .insert({ ...c.req.valid("json"), property_id: c.req.valid("param").id }).select().single();
    if (error) throw fromDb(error);
    return c.json(data as Booking, 201);
  });

const byId = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const { data, error } = await c.get("db").from("bookings").select("*").order("check_in");
    if (error) throw fromDb(error);
    return c.json(data as Booking[]);
  })
  .get("/:id", validate("param", id), async (c) => {
    const { data, error } = await c.get("db").from("bookings").select("*").eq("id", c.req.valid("param").id).maybeSingle();
    if (error) throw fromDb(error);
    if (!data) throw new HttpError(404, "Booking not found", "NOT_FOUND");
    return c.json(data as Booking);
  })
  .patch("/:id", validate("param", id), validate("json", updateBooking), async (c) => {
    const { data, error } = await c.get("db").from("bookings").update(c.req.valid("json"))
      .eq("id", c.req.valid("param").id).select().maybeSingle();
    if (error) throw fromDb(error);
    // not visible to this user (or missing) -> same answer, so bookings of others are not revealed
    if (!data) throw new HttpError(404, "Booking not found", "NOT_FOUND");
    return c.json(data as Booking);
  })
  .delete("/:id", validate("param", id), async (c) => {
    const { data, error } = await c.get("db").from("bookings").delete().eq("id", c.req.valid("param").id).select().maybeSingle();
    if (error) throw fromDb(error);
    if (!data) throw new HttpError(404, "Booking not found", "NOT_FOUND");
    return c.body(null, 204);
  });

export const bookingRoutes = { forProperty, byId };
