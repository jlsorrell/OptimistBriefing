import { z } from "zod";

import { EditionSchema } from "../contracts/editorial";

const EditionCursorSchema = z
  .object({
    editionDate: EditionSchema.shape.editionDate,
  })
  .strict();

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Cursor is not base64url.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeEditionCursor(editionDate: string): string {
  const parsed = EditionSchema.shape.editionDate.parse(editionDate);
  return toBase64Url(JSON.stringify({ editionDate: parsed }));
}

export function decodeEditionCursor(cursor: string): string {
  const parsed: unknown = JSON.parse(fromBase64Url(cursor));
  return EditionCursorSchema.parse(parsed).editionDate;
}
