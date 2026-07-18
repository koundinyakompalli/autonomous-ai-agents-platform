import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  hasTrustedOperatorIdentityMock,
  isOneShotDeploymentRequestSupportedMock,
  isOneShotJiraValidationConfiguredMock,
  isOneShotRunRequestSupportedMock,
  isQualifierAgentAvailableMock,
  generateOneShotCostReportMock,
  normalizeOneShotCostReportQueryMock,
  oneShotCostReportFilenameMock,
  renderOneShotCostReportCsvMock,
  renderOneShotCostReportHtmlMock,
  updateOneShotRunTicketTypeMock,
} = vi.hoisted(() => ({
  getTrustedOperatorIdentityMock: vi.fn(),
  hasTrustedOperatorIdentityMock: vi.fn(),
  isOneShotDeploymentRequestSupportedMock: vi.fn(),
  isOneShotJiraValidationConfiguredMock: vi.fn(),
  isOneShotRunRequestSupportedMock: vi.fn(),
  isQualifierAgentAvailableMock: vi.fn(),
  generateOneShotCostReportMock: vi.fn(),
  normalizeOneShotCostReportQueryMock: vi.fn(),
  oneShotCostReportFilenameMock: vi.fn(),
  renderOneShotCostReportCsvMock: vi.fn(),
  renderOneShotCostReportHtmlMock: vi.fn(),
  updateOneShotRunTicketTypeMock: vi.fn(),
}));

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  hasTrustedOperatorIdentity: hasTrustedOperatorIdentityMock,
  OperatorIdentityError: class OperatorIdentityError extends Error {
    statusCode = 403;
  },
}));

vi.mock("../services/oneshot.js", () => ({
  getOneShotRowByDashboardId: vi.fn(),
  getOneShotRuns: vi.fn(),
  updateOneShotRunTicketType: updateOneShotRunTicketTypeMock,
  OneShotTicketTypeUpdateError: class OneShotTicketTypeUpdateError extends Error {
    statusCode = 400;
  },
}));

vi.mock("../services/oneshotAnalytics.js", () => ({
  normalizeOneShotAnalyticsRange: vi.fn(() => "24h"),
}));

vi.mock("../services/oneshotCostReports.js", () => ({
  generateOneShotCostReport: generateOneShotCostReportMock,
  normalizeOneShotCostReportQuery: normalizeOneShotCostReportQueryMock,
  oneShotCostReportFilename: oneShotCostReportFilenameMock,
  renderOneShotCostReportCsv: renderOneShotCostReportCsvMock,
  renderOneShotCostReportHtml: renderOneShotCostReportHtmlMock,
}));

vi.mock("../services/oneshotDeployments.js", () => ({
  isOneShotDeploymentRequestSupported: isOneShotDeploymentRequestSupportedMock,
}));

vi.mock("../services/oneshotJiraLookup.js", () => ({
  isOneShotJiraValidationConfigured: isOneShotJiraValidationConfiguredMock,
}));

vi.mock("../services/oneshotMockData.js", () => ({
  createMockRun: vi.fn(),
  getMockData: vi.fn(),
  getMockRow: vi.fn(),
}));

vi.mock("../services/oneshotRowHelpers.js", () => ({
  bucketForView: vi.fn(),
}));

vi.mock("../services/oneshotRunRequests.js", () => ({
  isOneShotRunRequestSupported: isOneShotRunRequestSupportedMock,
  isQualifierAgentAvailable: isQualifierAgentAvailableMock,
}));

vi.mock("../services/oneshotTimeline.js", () => ({
  buildFallbackTimeline: vi.fn(),
  getOneShotRunTimeline: vi.fn(),
}));

vi.mock("../services/oneshotStatistics.js", () => ({
  buildMockOneShotStatistics: vi.fn(),
  getOneShotStatistics: vi.fn(),
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshot.js");
}

describe("oneshot route capabilities", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    hasTrustedOperatorIdentityMock.mockReset();
    isOneShotDeploymentRequestSupportedMock.mockReset();
    isOneShotJiraValidationConfiguredMock.mockReset();
    isOneShotRunRequestSupportedMock.mockReset();
    isQualifierAgentAvailableMock.mockReset();
    generateOneShotCostReportMock.mockReset();
    normalizeOneShotCostReportQueryMock.mockReset();
    oneShotCostReportFilenameMock.mockReset();
    renderOneShotCostReportCsvMock.mockReset();
    renderOneShotCostReportHtmlMock.mockReset();
    updateOneShotRunTicketTypeMock.mockReset();

    hasTrustedOperatorIdentityMock.mockReturnValue(false);
    isOneShotDeploymentRequestSupportedMock.mockResolvedValue(true);
    isOneShotJiraValidationConfiguredMock.mockReturnValue(true);
    isOneShotRunRequestSupportedMock.mockResolvedValue(true);
    isQualifierAgentAvailableMock.mockResolvedValue(true);
  });

  it("exposes create-run availability and deploy availability even without operator identity", async () => {
    const { resolveCapabilities } = await loadModule();

    await expect(resolveCapabilities({} as any)).resolves.toEqual({
      createRun: true,
      createRunMode: "request",
      deployPreviewAvailable: true,
      deployPreview: false,
    });
  });

  it("keeps authenticated deploy capability tied to trusted operator identity", async () => {
    hasTrustedOperatorIdentityMock.mockReturnValue(true);
    const { resolveCapabilities } = await loadModule();

    await expect(resolveCapabilities({} as any)).resolves.toEqual({
      createRun: true,
      createRunMode: "request",
      deployPreviewAvailable: true,
      deployPreview: true,
    });
  });

  it("keeps create-run availability tied to backend prerequisites", async () => {
    isQualifierAgentAvailableMock.mockResolvedValue(false);
    const { resolveCapabilities } = await loadModule();

    await expect(resolveCapabilities({} as any)).resolves.toEqual({
      createRun: false,
      createRunMode: "request",
      deployPreviewAvailable: true,
      deployPreview: false,
    });
  });
});

describe("oneshot ticket type route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    updateOneShotRunTicketTypeMock.mockReset();
  });

  it("updates normalized ticket type with trusted operator identity", async () => {
    const operator = { id: "operator-1", display: "Ravi" };
    const row = { dashboardId: "run-123", ticketType: "security" };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    updateOneShotRunTicketTypeMock.mockResolvedValue(row);
    const { default: router } = await loadModule();
    const layer = (router.stack as any[]).find(
      (candidate) =>
        candidate.route?.path === "/runs/:dashboardId/ticket-type" &&
        candidate.route?.methods?.patch,
    );
    const handler = layer?.route?.stack?.[0]?.handle;
    expect(handler).toBeTypeOf("function");
    const req = {
      params: { dashboardId: "run-123" },
      body: { ticketType: "security" },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ row });
    expect(updateOneShotRunTicketTypeMock).toHaveBeenCalledWith({
      dashboardId: "run-123",
      ticketType: "security",
      operator,
    });
  });
});

describe("oneshot cost report routes", () => {
  beforeEach(() => {
    generateOneShotCostReportMock.mockReset();
    normalizeOneShotCostReportQueryMock.mockReset();
    oneShotCostReportFilenameMock.mockReset();
    renderOneShotCostReportCsvMock.mockReset();
    renderOneShotCostReportHtmlMock.mockReset();
  });

  it("returns the CSV report as an attachment", async () => {
    const normalizedQuery = { range: "7d", ticketType: "sonar" };
    const report = { window: normalizedQuery };
    normalizeOneShotCostReportQueryMock.mockReturnValue(normalizedQuery);
    generateOneShotCostReportMock.mockResolvedValue(report);
    oneShotCostReportFilenameMock.mockReturnValue("oneshot-costs-7d-sonar.csv");
    renderOneShotCostReportCsvMock.mockReturnValue("jira_key\nCPDEV-1\n");
    const { default: router } = await loadModule();
    const layer = (router.stack as any[]).find(
      (candidate) =>
        candidate.route?.path === "/reports/costs.csv" &&
        candidate.route?.methods?.get,
    );
    const handler = layer?.route?.stack?.[0]?.handle;
    const req = { query: { range: "7d", ticketType: "sonar" } };
    const res = {
      setHeader: vi.fn(),
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handler(req, res);

    expect(normalizeOneShotCostReportQueryMock).toHaveBeenCalledWith({
      range: "7d",
      ticketType: "sonar",
    });
    expect(generateOneShotCostReportMock).toHaveBeenCalledWith(normalizedQuery);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/csv; charset=utf-8",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="oneshot-costs-7d-sonar.csv"',
    );
    expect(res.send).toHaveBeenCalledWith("jira_key\nCPDEV-1\n");
  });

  it("returns the HTML report as an attachment", async () => {
    const normalizedQuery = { range: "30d", ticketType: "all" };
    const report = { window: normalizedQuery };
    normalizeOneShotCostReportQueryMock.mockReturnValue(normalizedQuery);
    generateOneShotCostReportMock.mockResolvedValue(report);
    oneShotCostReportFilenameMock.mockReturnValue("oneshot-costs-30d-all.html");
    renderOneShotCostReportHtmlMock.mockReturnValue("<!doctype html>");
    const { default: router } = await loadModule();
    const layer = (router.stack as any[]).find(
      (candidate) =>
        candidate.route?.path === "/reports/costs.html" &&
        candidate.route?.methods?.get,
    );
    const handler = layer?.route?.stack?.[0]?.handle;
    const req = { query: { range: "30d", ticketType: "bogus" } };
    const res = {
      setHeader: vi.fn(),
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handler(req, res);

    expect(normalizeOneShotCostReportQueryMock).toHaveBeenCalledWith({
      range: "30d",
      ticketType: "bogus",
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="oneshot-costs-30d-all.html"',
    );
    expect(res.send).toHaveBeenCalledWith("<!doctype html>");
  });
});
