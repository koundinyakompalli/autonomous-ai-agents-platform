import { describe, expect, it } from "vitest";
import { aboutPanelHref } from "./aboutData.js";

// Locks the URL contract that ProductLocalNav anchors and OneShotPage's
// writeRouteStateToUrl both depend on. If aboutPanelHref drifts away from
// normalizeAboutPanel's accepted forms, deep-linked tabs stop hydrating.
describe("aboutPanelHref", () => {
  it("returns the bare About URL for features (no panel param)", () => {
    expect(aboutPanelHref("features")).toBe("?view=about");
  });

  it.each([
    ["how-to", "?view=about&panel=how-to"],
    ["tech-spec", "?view=about&panel=tech-spec"],
    ["changelog", "?view=about&panel=changelog"],
  ] as const)("emits canonical href for panel=%s", (panel, expected) => {
    expect(aboutPanelHref(panel)).toBe(expected);
  });
});
