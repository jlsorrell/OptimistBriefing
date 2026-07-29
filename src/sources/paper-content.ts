import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import type { AccessLevel } from "../contracts/editorial";
import { SourceHttpClient } from "./http-client";
import {
  bodyRetrievalPermitted,
  ResearchSourceRecordSchema,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

export type PaperContentRequest = {
  source: ResearchSourceInput;
  htmlUrl: string | null;
  abstract: string;
};

export type RetrievedPaperContent = {
  accessLevel: Extract<AccessLevel, "abstract" | "full_text">;
  text: string;
};

function isArxivHtmlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.hostname === "arxiv.org" || url.hostname.endsWith(".arxiv.org")) &&
      url.pathname.startsWith("/html/")
    );
  } catch {
    return false;
  }
}

export class PaperContentRetriever {
  constructor(private readonly http: SourceHttpClient) {}

  async retrieve(
    request: PaperContentRequest,
  ): Promise<RetrievedPaperContent> {
    const fallback: RetrievedPaperContent = {
      accessLevel: "abstract",
      text: request.abstract,
    };
    const source: ResearchSourceRecord =
      ResearchSourceRecordSchema.parse(request.source);
    if (
      !bodyRetrievalPermitted(source) ||
      request.htmlUrl === null ||
      !isArxivHtmlUrl(request.htmlUrl)
    ) {
      return fallback;
    }

    try {
      const response = await this.http.get(source, request.htmlUrl, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      if (
        response.body === null ||
        response.contentType?.toLowerCase().includes("html") !== true
      ) {
        return fallback;
      }
      const { document } = parseHTML(response.body);
      const article = new Readability(
        document as unknown as Document,
      ).parse();
      const text = article?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length < 200) {
        return fallback;
      }
      return {
        accessLevel: "full_text",
        text,
      };
    } catch {
      return fallback;
    }
  }
}
