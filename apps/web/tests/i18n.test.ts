import { describe, expect, it } from "vitest";
// @vitest-environment happy-dom
import { applyLocale, translate } from "../src/lib/i18n";

describe("i18n English-first with Urdu support", () => {
  it("falls back to English for missing Urdu keys", () => {
    expect(translate("ur", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("translates navigation into Urdu", () => {
    expect(translate("ur", "nav.dashboard")).toMatch(/ڈیش بورڈ/);
    expect(translate("en", "nav.dashboard")).toBe("Dashboard");
  });

  it("applies RTL direction for Urdu", () => {
    applyLocale("ur");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toContain("ur");
    applyLocale("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
