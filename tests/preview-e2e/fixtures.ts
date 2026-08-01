import {
  expect,
  test as base,
  type Page,
  type Route,
} from "@playwright/test";

import {
  PREVIEW_ORIGIN,
  resolvePreviewAccessToken,
} from "../../scripts/preview-e2e/environment";

export function headersForPreviewRequest(
  requestURL: string,
  accessToken: string,
  headers: Record<string, string>,
): Record<string, string> {
  let origin: string | undefined;
  try {
    origin = new URL(requestURL).origin;
  } catch {
    return { ...headers };
  }
  if (origin !== PREVIEW_ORIGIN) return { ...headers };
  return {
    ...headers,
    authorization: `Bearer ${accessToken}`,
  };
}

export async function getPreviewJSON(page: Page, path: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("Preview API requests must use a relative exact-origin path");
  }
  let requestURL: URL;
  try {
    requestURL = new URL(path, `${PREVIEW_ORIGIN}/`);
  } catch {
    throw new Error("Preview API requests must use a relative exact-origin path");
  }
  if (requestURL.origin !== PREVIEW_ORIGIN) {
    throw new Error("Preview API requests must use a relative exact-origin path");
  }
  const accessToken = resolvePreviewAccessToken(
    process.env.OPTIMIST_PREVIEW_ACCESS_TOKEN,
  );
  return await page.context().request.get(requestURL.href, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export async function routePreviewRequest(
  route: Route,
  accessToken: string,
): Promise<void> {
  const request = route.request();
  let isPreviewOrigin = false;
  try {
    isPreviewOrigin = new URL(request.url()).origin === PREVIEW_ORIGIN;
  } catch {
    // Invalid or non-HTTP request URLs never receive the bearer token.
  }
  if (!isPreviewOrigin) {
    await route.continue();
    return;
  }
  const response = await route.fetch({
    headers: headersForPreviewRequest(
      request.url(),
      accessToken,
      request.headers(),
    ),
    maxRedirects: 0,
  });
  await route.fulfill({ response });
}

export const test = base.extend<{ previewAuthorization: void }>({
  previewAuthorization: [async ({ page }, use) => {
    const accessToken = resolvePreviewAccessToken(
      process.env.OPTIMIST_PREVIEW_ACCESS_TOKEN,
    );
    await page.route("**/*", async (route) => {
      await routePreviewRequest(route, accessToken);
    });
    await use();
  }, { auto: true }],
});

export { expect };
