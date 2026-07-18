import { describe, expect, it } from "vitest";
import { buildDeterministicSearchFinding } from "./watchdogRunner.js";

describe("buildDeterministicSearchFinding", () => {
  it("extracts root cause from Spring startup failures", () => {
    const finding = buildDeterministicSearchFinding({
      evidenceId: "wdg_ev_test",
      approvedScope: {
        clientId: "MEDHOK",
        environment: "RUD1",
        serviceIds: ["core"],
        includeKeywords: ["error"],
        excludeKeywords: [],
        timeWindow: {
          startTs: "2026-04-30T13:00:00Z",
          endTs: "2026-04-30T14:00:00Z",
          sourceHint: "last 1 hour",
        },
      },
      search: {
        search_id: "search-test",
        summary_counts: {
          total_matches: 29,
          returned_samples: 29,
          regions: { "us-east-1": 29 },
          log_groups: {
            "239350186085:/CP/MEDHOK/RUD1/core": 11,
            "239350186085:/CP/MEDHOK/RUD1/core/catalina": 18,
          },
        },
        top_samples: [
          {
            timestamp: "2026-04-30 13:53:32.832",
            log_group_name: "239350186085:/CP/MEDHOK/RUD1/core/catalina",
            log_stream: "i-0521f0b5c46267bf7",
            message: "SEVERE [main] org.apache.catalina.core.StandardContext.startInternal Context [/medhok] startup failed due to previous errors",
          },
          {
            timestamp: "2026-04-30 13:53:32.745",
            log_group_name: "239350186085:/CP/MEDHOK/RUD1/core",
            log_stream: "i-0521f0b5c46267bf7",
            message:
              "Caused by: org.springframework.beans.factory.UnsatisfiedDependencyException: Error creating bean with name 'searchService': Unsatisfied dependency expressed through field 'fHIRMemberSearchService'; nested exception is org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'fhirMemberSearchService': Invocation of init method failed; nested exception is java.lang.IllegalArgumentException: max-results cannot be negative",
          },
        ],
      },
    });

    expect(finding.severity).toBe("critical");
    expect(finding.title).toContain("startup blocked");
    expect(finding.title).toContain("IllegalArgumentException: max-results cannot be negative");
    expect(finding.summary).toContain("Root error: IllegalArgumentException: max-results cannot be negative");
    expect(finding.details?.affectedBean).toBe("fhirMemberSearchService");
    expect(finding.evidenceIds).toEqual(["wdg_ev_test"]);
  });
});
