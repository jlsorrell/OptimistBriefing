import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { z } from "zod";

import { assertSafeOutboundUrl } from "./outbound-url";

export const MAX_EXTRACTED_ARTICLE_CHARACTERS = 100_000;
export const MIN_COMPLETE_ARTICLE_CHARACTERS = 500;

export const ExtractedArticleSchema = z.object({
  title: z.string().min(1).nullable(),
  byline: z.string().min(1).nullable(),
  excerpt: z.string().min(1).nullable(),
  text: z.string().min(1).max(MAX_EXTRACTED_ARTICLE_CHARACTERS).nullable(),
  extractionLevel: z.enum(["full", "partial", "metadata-only"]),
});

export type ExtractedArticle = z.infer<typeof ExtractedArticleSchema>;

function metadataOnly(): ExtractedArticle {
  return {
    title: null,
    byline: null,
    excerpt: null,
    text: null,
    extractionLevel: "metadata-only",
  };
}

function normalized(value: string | null | undefined): string | null {
  const result = value?.replace(/\s+/g, " ").trim() ?? "";
  return result.length === 0 ? null : result;
}

function isHtmlContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

export function extractReadableArticle(
  html: string,
  url: string,
  contentType: string | null = "text/html",
): ExtractedArticle {
  assertSafeOutboundUrl(url);
  if (!isHtmlContentType(contentType)) {
    return metadataOnly();
  }

  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll(
    "script, style, noscript, nav, form, header, footer, aside, [role='navigation']",
  )) {
    element.remove();
  }
  const fallbackText = normalized(
    document.querySelector("article, main")?.textContent,
  );
  const fallbackTitle = normalized(
    document.querySelector("h1")?.textContent ??
      document.querySelector("title")?.textContent,
  );
  const fallbackExcerpt = normalized(
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content"),
  );
  const article = new Readability(
    document as unknown as Document,
    { charThreshold: 100 },
  ).parse();
  const readabilityText = normalized(article?.textContent);
  const fullText = readabilityText ?? fallbackText;
  if (fullText === null) {
    return metadataOnly();
  }
  const wasTruncated =
    fullText.length > MAX_EXTRACTED_ARTICLE_CHARACTERS;

  return ExtractedArticleSchema.parse({
    title: normalized(article?.title) ?? fallbackTitle,
    byline: normalized(article?.byline),
    excerpt: normalized(article?.excerpt) ?? fallbackExcerpt,
    text: wasTruncated
      ? fullText.slice(0, MAX_EXTRACTED_ARTICLE_CHARACTERS)
      : fullText,
    extractionLevel:
      wasTruncated ||
      readabilityText === null ||
      fullText.length < MIN_COMPLETE_ARTICLE_CHARACTERS
        ? "partial"
        : "full",
  });
}
