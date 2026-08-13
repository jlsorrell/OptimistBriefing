import type { Hono } from "hono";

import { EditionSectionSchema } from "../../contracts/editorial";
import { RepositoryValidationError } from "../../db/repository";
import { readerCalendarDate } from "../../time/calendar-date";
import type { AppDependencies, AppEnv } from "../app";

function optionalFilter(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

export function registerArchiveRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.get("/api/archive", async (context) => {
    const badRequest = () =>
      context.json(
        {
          error: {
            code: "VALIDATION_FAILED" as const,
            message: "The archive query could not be validated.",
          },
        },
        400,
      );
    const searchParams = new URL(context.req.url).searchParams;
    const allowed = new Set([
      "q",
      "topic",
      "author",
      "institution",
      "source",
      "section",
      "limit",
      "cursor",
      "saved",
    ]);
    for (const key of searchParams.keys()) {
      if (!allowed.has(key) || searchParams.getAll(key).length !== 1) {
        return badRequest();
      }
    }
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
    const query = optionalFilter(context.req.query("q"));
    const topic = optionalFilter(context.req.query("topic"));
    const author = optionalFilter(context.req.query("author"));
    const institution = optionalFilter(context.req.query("institution"));
    const source = optionalFilter(context.req.query("source"));
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !parsedSection.success ||
      (rawSaved !== undefined && rawSaved !== "true" && rawSaved !== "false") ||
      query === undefined ||
      topic === undefined ||
      author === undefined ||
      institution === undefined ||
      source === undefined
    ) {
      return badRequest();
    }
    try {
      return context.json(
        await dependencies.repository.searchArchive({
          query,
          topic,
          author,
          institution,
          source,
          section: parsedSection.data,
          limit,
          cursor: context.req.query("cursor") ?? null,
          saved: rawSaved === "true",
          editionDateNotAfter: readerCalendarDate(
            dependencies.now?.() ?? new Date(),
          ),
        }),
      );
    } catch (error) {
      if (error instanceof RepositoryValidationError) {
        return badRequest();
      }
      throw error;
    }
  });
}
