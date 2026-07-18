import { describe, expect, it } from "vitest";
import {
  resolveOneShotProcessingMode,
  resolveOneShotProcessingModeFromIntake,
} from "./processing-mode.js";

describe("resolveOneShotProcessingModeFromIntake", () => {
  it("routes SONAR-AUTOFIX tickets to the sonar lane", () => {
    expect(resolveOneShotProcessingModeFromIntake(["SONAR-AUTOFIX"])).toBe(
      "sonar_autofix",
    );
  });

  it("does not route PFOS tickets to the security lane from label alone", () => {
    expect(resolveOneShotProcessingModeFromIntake(["PFOS"])).toBe("standard");
  });

  it("routes WIZ-CODE tickets to the wiz_code (SAST) lane", () => {
    expect(resolveOneShotProcessingModeFromIntake(["WIZ-CODE"])).toBe(
      "wiz_code",
    );
  });

  it("keeps Sonar ahead of WIZ-CODE when both labels are present", () => {
    expect(
      resolveOneShotProcessingModeFromIntake(["SONAR-AUTOFIX", "WIZ-CODE"]),
    ).toBe("sonar_autofix");
  });

  it("keeps Sonar ahead of generic security wording", () => {
    expect(
      resolveOneShotProcessingModeFromIntake(["SONAR-AUTOFIX", "security"]),
    ).toBe("sonar_autofix");
  });
});

describe("resolveOneShotProcessingMode", () => {
  it("prefers persisted processingMode when present", () => {
    expect(
      resolveOneShotProcessingMode({
        processingMode: "sonar_autofix",
        jiraLabels: ["PFOS"],
        ticketSummary: "[Security] misleading title",
      }),
    ).toBe("sonar_autofix");
  });

  it("uses legacy SONAR-AUTOFIX labels when old artifacts have no explicit mode", () => {
    expect(
      resolveOneShotProcessingMode({
        jiraLabels: ["SONAR-AUTOFIX", "security"],
        ticketSummary: "[Security] vulnerability flavored Sonar story",
      }),
    ).toBe("sonar_autofix");
  });

  it("falls back to Wiz title heuristics for legacy security artifacts", () => {
    expect(
      resolveOneShotProcessingMode({
        jiraLabels: [],
        ticketSummary:
          "[Security] jackson-databind - cp-medhok-monorepo - Wiz remediation",
      }),
    ).toBe("security_wiz");
  });

  it("keeps PFOS-labeled UI tickets in the standard lane without CVE evidence", () => {
    expect(
      resolveOneShotProcessingMode({
        jiraLabels: ["PFOS"],
        ticketSummary: "Add a red cancel button to Member Search",
      }),
    ).toBe("standard");
  });

  it("routes WIZ-CODE-labeled tickets to the wiz_code lane", () => {
    expect(
      resolveOneShotProcessingMode({
        jiraLabels: ["WIZ-CODE"],
        ticketSummary: "[Wiz Code] CWE-89 — ProviderPortal",
      }),
    ).toBe("wiz_code");
  });
});
