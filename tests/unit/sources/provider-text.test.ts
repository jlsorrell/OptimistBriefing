import { describe, expect, it } from "vitest";

import {
  decodeProviderTextEntities,
  normalizeProviderText,
} from "../../../src/sources/provider-text";

describe("provider text normalization", () => {
  it("decodes decimal, hexadecimal, named, and double-encoded references", () => {
    expect(decodeProviderTextEntities(
      "&#8216;safe&#8217; &#x201C;text&#x201D; &amp; &quot;ok&quot; &amp;#8217;",
    )).toBe("‘safe’ “text” & \"ok\" ’");
  });

  it("keeps unsupported and unsafe references inert", () => {
    expect(decodeProviderTextEntities(
      "&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished",
    )).toBe("&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished");
  });

  it("returns bounded plain text after decoding and tag removal", () => {
    expect(normalizeProviderText(
      "&lt;script&gt;bad()&lt;/script&gt; &nbsp; useful   text",
      { stripHtml: true, maxCharacters: 20 },
    )).toBe("bad() useful text");
  });

  it("normalizes empty input to null", () => {
    expect(normalizeProviderText(" &nbsp; ")).toBeNull();
    expect(normalizeProviderText(null)).toBeNull();
  });
});
