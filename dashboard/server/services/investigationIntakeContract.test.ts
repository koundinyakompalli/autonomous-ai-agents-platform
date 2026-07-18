import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("investigation intake contract", () => {
  it("keeps validateOneShotRunRequestJiraKey out of Cockpit intake", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const cockpitService = readFileSync(join(currentDir, "investigation.ts"), "utf8");
    const oneShotRoute = readFileSync(join(currentDir, "../routes/oneshotRunRequests.ts"), "utf8");
    const serverIndex = readFileSync(join(currentDir, "../index.ts"), "utf8");

    expect(cockpitService).not.toContain("validateOneShotRunRequestJiraKey");
    expect(oneShotRoute.match(/await validateOneShotRunRequestJiraKey/g)).toHaveLength(2);
    expect(oneShotRoute).toContain('router.post("/validate", postOneShotRunRequestValidation)');
    expect(oneShotRoute).toContain('router.post("/", postOneShotRunRequest)');
    expect(serverIndex).toContain("app.use('/api/oneshot/run-requests', oneshotRunRequestsRouter)");
  });

  it("places fetched Jira ticketContext into run scope before adapters execute", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const cockpitService = readFileSync(join(currentDir, "investigation.ts"), "utf8");
    const fetchIndex = cockpitService.indexOf("await fetchInvestigationJiraContext(normalizedJiraKey)");
    const scopeIndex = cockpitService.indexOf("...(ticketContext ? { ticketContext } : {})");
    const executeIndex = cockpitService.indexOf("await controlPlane.executeRun(executableRun)");

    expect(fetchIndex).toBeGreaterThan(-1);
    expect(scopeIndex).toBeGreaterThan(fetchIndex);
    expect(executeIndex).toBeGreaterThan(scopeIndex);
  });
});
