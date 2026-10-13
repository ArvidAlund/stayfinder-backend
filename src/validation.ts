import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { HttpError } from "./errors.js";

/** zValidator that turns zod failures into a 400 with per-field messages. */
export const validate = <T extends ZodType>(target: keyof ValidationTargets, schema: T) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const i of result.error.issues) fields[i.path.join(".") || "_"] ??= i.message;
      throw new HttpError(400, "Validation failed", "VALIDATION_ERROR", fields);
    }
  });
