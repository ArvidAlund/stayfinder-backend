import type { PostgrestError } from "@supabase/supabase-js";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, message: string, public code?: string, public details?: Record<string, string>) {
    super(message);
  }
}

// Business-rule errors raised by DB triggers look like "CODE: text" (see migration).
const RULE_STATUS: Record<string, ContentfulStatusCode> = {
  CHECKIN_IN_PAST: 422,
  CAPACITY_EXCEEDED: 422,
  CHECKIN_PASSED: 409,
  BOOKING_CANCELLED: 409,
  INVALID_TRANSITION: 409,
  FORBIDDEN_TRANSITION: 403,
  FORBIDDEN_EDIT: 403,
  IMMUTABLE_FIELD: 422,
  PROPERTY_NOT_FOUND: 404,
};

/** Translate a Postgres/PostgREST error into an HttpError with a clear message. */
export function fromDb(err: PostgrestError): HttpError {
  const rule = /^([A-Z_]+): (.*)$/s.exec(err.message);
  if (rule && RULE_STATUS[rule[1]]) return new HttpError(RULE_STATUS[rule[1]], rule[2], rule[1]);
  if (err.code === "23P01") return new HttpError(409, "Property is already booked for these dates", "BOOKING_OVERLAP");
  if (err.code === "23514" || err.code === "22P02" || err.code === "22007" || err.code === "22008")
    return new HttpError(400, "Invalid data", "INVALID_DATA");
  if (err.code === "23503") return new HttpError(404, "Referenced resource not found", "NOT_FOUND");
  if (err.code === "42501") return new HttpError(403, "Not allowed", "FORBIDDEN");
  return new HttpError(500, "Database error", "DB_ERROR");
}
