import { z } from "zod";
import {
  EditionEntrySchema,
  EditionSchema,
  EditionWithEntriesSchema,
} from "./editorial";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const EditionPageSchema = z.object({
  items: z.array(EditionSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const ArchiveSearchPageSchema = z.object({
  items: z.array(EditionEntrySchema),
  nextCursor: z.string().min(1).nullable(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "AUTH_REQUIRED",
      "AUTH_FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION_FAILED",
      "SOURCE_ALREADY_EXISTS",
      "SOURCE_ID_ALREADY_EXISTS",
      "INTERNAL_ERROR",
    ]),
    message: z.string().min(1),
  }),
});

export { EditionWithEntriesSchema };

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type EditionPage = z.infer<typeof EditionPageSchema>;
export type ArchiveSearchPage = z.infer<typeof ArchiveSearchPageSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
