import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/ticket-readiness-corpus.json";
import {
  READINESS_RUBRIC,
  scoreTicketReadiness,
} from "./ticketReadiness.js";
import type {
  OneShotTicketReadinessSignal,
  OneShotTicketReadinessTier,
  OneShotTicketTemplateFit,
} from "../types/oneshot.js";

type CorpusCase = {
  name: string;
  title: string;
  taskDescription: string;
  expectedTier: OneShotTicketReadinessTier;
  expectedTemplateFit: OneShotTicketTemplateFit;
  expectedSignals: OneShotTicketReadinessSignal[];
};

describe("ticket readiness scoring", () => {
  it("scores CPDEV-template tickets as strong template-fit", () => {
    const score = scoreTicketReadiness({
      title: "Default provider search to active",
      taskDescription:
        "Summary: Provider search should default to active providers.\nOverview: The ProviderSearchController currently returns inactive records.\nAcceptance Criteria:\n- Given no status filter, when search runs, then inactive providers are excluded.\nTechnical Details: Update provider-portal ProviderSearchService.java.\nTesting Notes: Add service tests.\nOut of Scope: Do not alter saved searches.",
    });

    expect(score.tier).toBe("strong");
    expect(score.templateFit).toBe("cpdev_template");
    expect(score.breakdown.acceptance_criteria).toBe(
      READINESS_RUBRIC.weights.acceptance_criteria,
    );
  });

  it("scores retrofit tickets with Retrofit, From, and Target as retrofit-fit", () => {
    const score = scoreTicketReadiness({
      title: "Retrofit provider search patch",
      taskDescription:
        "Retrofit: Port the provider search active-default change.\nFrom: provider-portal main commit def456.\nTarget: provider-portal release/2026.05.\nScope: Copy the ProviderSearchService and request mapper changes only.\nTesting Notes: Run ProviderSearchServiceTest and mapper tests.",
    });

    expect(score.tier).toBe("adequate");
    expect(score.templateFit).toBe("retrofit_template");
  });

  it("does not penalize clear free-form tickets for missing template headings", () => {
    const score = scoreTicketReadiness({
      title: "Prevent inactive auth rows from default search",
      taskDescription:
        "Users keep selecting inactive authorization rows by accident. The core-app authorization search service should exclude inactive rows unless the status filter explicitly includes them. Update AuthorizationSearchService and the React grid request mapper, then add unit coverage for default and all-status searches. Do not change exports.",
    });

    expect(["adequate", "strong"]).toContain(score.tier);
    expect(score.templateFit).toBe("non_template_clear");
  });

  it("scores missing or very short descriptions as missing_description", () => {
    const score = scoreTicketReadiness({
      title: "Fix search",
      taskDescription: "Make it better.",
    });

    expect(score.tier).toBe("missing_description");
    expect(score.templateFit).toBe("missing_description");
  });

  it("matches the anonymized OneShot ticket corpus", () => {
    expect((corpus as CorpusCase[]).length).toBeGreaterThanOrEqual(30);

    for (const item of corpus as CorpusCase[]) {
      const score = scoreTicketReadiness({
        title: item.title,
        taskDescription: item.taskDescription,
      });
      expect(score.tier, `${item.name} tier`).toBe(item.expectedTier);
      expect(score.templateFit, `${item.name} template fit`).toBe(
        item.expectedTemplateFit,
      );
      for (const signal of item.expectedSignals) {
        expect(score.signals[signal], `${item.name} ${signal}`).toBe(true);
      }
    }
  });
});
