import type { Hono } from "hono";

import { EditionSectionSchema } from "../../contracts/editorial";
import { RepositoryValidationError } from "../../db/repository";
import type { AppDependencies, AppEnv } from "../app";
import { ValidationError } from "../errors";

function optionalFilter(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError();
  }
  return trimmed;
}

export function registerArchiveRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.get("/api/archive", async (context) => {
    const rawLimit = context.req.query("limit");
    const limit =
      rawLimit === undefined
        ? 20
        : /^\d+$/.test(rawLimit)
          ? Number(rawLimit)
          : Number.NaN;
    const parsedSection = EditionSectionSchema.nullable().safeParse(
      context.req.query("section") ?? null,
    );
    const rawSaved = context.req.query("saved");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !parsedSection.success ||
      (rawSaved !== undefined && rawSaved !== "true" && rawSaved !== "false")
    ) {
      throw new ValidationError();
    }
    try {
      return context.json(
        await dependencies.repository.searchArchive({
          query: optionalFilter(context.req.query("q")),
          topic: optionalFilter(context.req.query("topic")),
          author: optionalFilter(context.req.query("author")),
          institution: optionalFilter(context.req.query("institution")),
          source: optionalFilter(context.req.query("source")),
          section: parsedSection.data,
          limit,
          cursor: context.req.query("cursor") ?? null,
          saved: rawSaved === "true",
        }),
      );
    } catch (error) {
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
  });
}
