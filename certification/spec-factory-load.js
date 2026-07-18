import http from "k6/http";
import { check, sleep } from "k6";
import execution from "k6/execution";
import { Counter, Trend } from "k6/metrics";

const scenario = __ENV.SCENARIO || "load.turn-design";
const baseUrl = requiredEnv("SPEC_FACTORY_BASE_URL").replace(/\/$/, "");
const sessionIds = requiredEnv("SPEC_FACTORY_SESSION_IDS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const authToken = __ENV.SPEC_FACTORY_AUTH_TOKEN || "";
const failures = new Counter("spec_factory_certification_failures");
const acceptedLatency = new Trend("spec_factory_turn_accept_ms", true);
const workflowLatency = new Trend("spec_factory_workflow_accept_ms", true);
const largeSourceBytes = numberEnv(
  "SPEC_FACTORY_LARGE_SOURCE_BYTES",
  10 * 1024 * 1024,
);
const largeSourceBody =
  scenario === "load.large-source-fanout"
    ? buildTextPayload(largeSourceBytes)
    : "";

export const options = optionsForScenario();

export default function () {
  const sessionId = sessionForIteration();
  if (scenario.startsWith("load.sse-")) {
    connectSse(sessionId);
    return;
  }
  if (scenario === "load.hot-session") {
    submitTurn(sessionIds[0]);
    return;
  }
  if (scenario === "load.mixed-workload") {
    runMixedOperation(sessionId);
    return;
  }
  if (scenario === "load.large-source-fanout") {
    uploadSource(sessionId, largeSourceBody);
    return;
  }
  if (scenario === "load.draft-burst") {
    requestHandoff(sessionId);
    return;
  }
  submitTurn(sessionId);
}

function optionsForScenario() {
  if (scenario.startsWith("load.sse-")) {
    return {
      scenarios: {
        sse: {
          executor: "constant-vus",
          vus: numberEnv(
            "SPEC_FACTORY_SSE_CLIENTS",
            scenario === "load.sse-stress" ? 25_000 : 5_000,
          ),
          duration: __ENV.SPEC_FACTORY_DURATION || "15m",
          gracefulStop: "30s",
        },
      },
      thresholds: {
        spec_factory_certification_failures: ["count==0"],
      },
    };
  }
  if (scenario === "load.draft-burst") {
    return {
      scenarios: {
        drafts: {
          executor: "shared-iterations",
          vus: Math.min(sessionIds.length, 100),
          iterations: sessionIds.length,
          maxDuration: __ENV.SPEC_FACTORY_DURATION || "30m",
        },
      },
      thresholds: workflowThresholds(false),
    };
  }
  const defaultRate =
    scenario === "load.turn-stress"
      ? 100
      : scenario === "load.soak-24h"
        ? 12
        : scenario === "load.mixed-workload"
          ? 5
          : scenario === "load.large-source-fanout"
            ? 1
            : scenario === "load.hot-session"
              ? 5
              : 20;
  const rate = numberEnv("SPEC_FACTORY_TURN_RATE", defaultRate);
  return {
    scenarios: {
      workload: {
        executor: "constant-arrival-rate",
        rate,
        timeUnit: "1s",
        duration:
          __ENV.SPEC_FACTORY_DURATION ||
          (scenario === "load.soak-24h" ? "24h" : "15m"),
        preAllocatedVUs: Math.max(rate, 50),
        maxVUs: Math.max(rate * 5, 250),
      },
    },
    thresholds:
      scenario === "load.mixed-workload" ||
      scenario === "load.large-source-fanout"
        ? workflowThresholds(scenario === "load.mixed-workload")
        : turnThresholds(),
  };
}

function runMixedOperation(sessionId) {
  switch (execution.scenario.iterationInTest % 7) {
    case 0:
      submitTurn(sessionId);
      break;
    case 1:
      submitAnalyze(sessionId);
      break;
    case 2:
      uploadSource(sessionId, buildTextPayload(64 * 1024));
      break;
    case 3:
      requestResearch(sessionId);
      break;
    case 4:
      requestHandoff(sessionId);
      break;
    case 5:
      approveReadyDraft(sessionId);
      break;
    default:
      readWorkflowState(sessionId);
      break;
  }
}

function connectSse(sessionId) {
  const response = http.get(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/stream`,
    {
      headers: headers(),
      timeout: __ENV.SPEC_FACTORY_SSE_HOLD || "2m",
      tags: { certificationScenario: scenario, operation: "sse" },
    },
  );
  record(
    check(response, {
      "SSE stream connected or held until timeout": (result) =>
        result.status === 200 || result.error_code === 1050,
    }),
  );
  sleep(Math.random() * 2);
}

function submitTurn(sessionId) {
  const key = uniqueKey("turn", sessionId);
  const response = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/messages`,
    JSON.stringify({ content: `Certification turn ${key}` }),
    jsonParams(key, "turn"),
  );
  acceptedLatency.add(response.timings.duration);
  record(
    check(response, {
      "turn accepted": (result) =>
        result.status === 200 || result.status === 202,
    }),
  );
}

function submitAnalyze(sessionId) {
  const key = uniqueKey("analyze", sessionId);
  const response = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/analyze`,
    JSON.stringify({ reset: false, repositoryIds: [] }),
    jsonParams(key, "analyze"),
  );
  acceptedLatency.add(response.timings.duration);
  record(
    check(response, {
      "analyze accepted": (result) =>
        result.status === 200 || result.status === 202,
    }),
  );
}

function uploadSource(sessionId, body) {
  const filename = `${uniqueKey("source", sessionId)}.txt`;
  const requested = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/uploads`,
    JSON.stringify({
      filename,
      mimeType: "text/plain",
      sizeBytes: body.length,
    }),
    jsonParams(null, "upload_request"),
  );
  workflowLatency.add(requested.timings.duration);
  if (
    !record(
      check(requested, {
        "upload target created": (result) => result.status === 201,
      }),
    )
  ) {
    return;
  }
  const target = responseJson(requested);
  if (!target?.uploadUrl || !target?.sourceId) {
    failures.add(1);
    return;
  }
  const uploaded = http.put(target.uploadUrl, body, {
    headers: { "Content-Type": "text/plain" },
    tags: { certificationScenario: scenario, operation: "upload_put" },
  });
  if (
    !record(
      check(uploaded, {
        "source uploaded to object store": (result) =>
          result.status >= 200 && result.status < 300,
      }),
    )
  ) {
    return;
  }
  const confirmed = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/sources/${target.sourceId}/uploaded`,
    null,
    jsonParams(null, "upload_confirm"),
  );
  record(
    check(confirmed, {
      "source conversion queued": (result) => result.status === 202,
    }),
  );
}

function requestResearch(sessionId) {
  const response = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/research/code`,
    JSON.stringify({
      question:
        "Identify one implementation fact and cite its repository path.",
      parentSourceIds: [],
    }),
    jsonParams(null, "research"),
  );
  workflowLatency.add(response.timings.duration);
  record(
    check(response, {
      "research accepted": (result) => result.status === 202,
    }),
  );
}

function requestHandoff(sessionId) {
  const response = http.post(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/handoff`,
    null,
    jsonParams(`cert-handoff-${sessionId}`, "handoff"),
  );
  workflowLatency.add(response.timings.duration);
  record(
    check(response, {
      "handoff accepted or deduplicated": (result) =>
        result.status === 200 || result.status === 202,
    }),
  );
}

function approveReadyDraft(sessionId) {
  const stateResponse = readWorkflowState(sessionId);
  if (stateResponse.status !== 200) return;
  const state = responseJson(stateResponse);
  const sourceId = state?.handoff?.sourceId;
  const draftId = state?.handoff?.draftId;
  if (!sourceId || !draftId) {
    check(stateResponse, { "draft is still progressing": () => true });
    return;
  }
  const response = http.post(
    `${baseUrl}/api/spec-factory/drafts/${draftId}/approve`,
    JSON.stringify({ sourceId }),
    jsonParams(null, "draft_approve"),
  );
  workflowLatency.add(response.timings.duration);
  record(
    check(response, {
      "draft approval accepted or already publishing": (result) =>
        result.status === 200 || result.status === 202,
    }),
  );
}

function readWorkflowState(sessionId) {
  const response = http.get(
    `${baseUrl}/api/spec-factory/compose/sessions/${sessionId}/workflow-state`,
    {
      headers: headers(),
      tags: { certificationScenario: scenario, operation: "workflow_state" },
    },
  );
  record(
    check(response, {
      "workflow state readable": (result) => result.status === 200,
    }),
  );
  return response;
}

function baseThresholds() {
  return {
    spec_factory_certification_failures: ["count==0"],
    http_req_failed: ["rate<0.01"],
  };
}

function turnThresholds() {
  return {
    ...baseThresholds(),
    spec_factory_turn_accept_ms: ["p(95)<500", "p(99)<1000"],
  };
}

function workflowThresholds(includeTurns) {
  const thresholds = {
    ...baseThresholds(),
    spec_factory_workflow_accept_ms: ["p(95)<1000", "p(99)<2000"],
  };
  return includeTurns
    ? {
        ...thresholds,
        spec_factory_turn_accept_ms: ["p(95)<500", "p(99)<1000"],
      }
    : thresholds;
}

function jsonParams(idempotencyKey, operation) {
  const requestHeaders = {
    ...headers(),
    "Content-Type": "application/json",
  };
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  return {
    headers: requestHeaders,
    tags: { certificationScenario: scenario, operation },
  };
}

function headers() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function responseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function sessionForIteration() {
  return sessionIds[execution.scenario.iterationInTest % sessionIds.length];
}

function uniqueKey(operation, sessionId) {
  return `cert-${scenario}-${operation}-${sessionId}-${execution.scenario.iterationInTest}-${Date.now()}`;
}

function record(passed) {
  if (!passed) failures.add(1);
  return passed;
}

function buildTextPayload(bytes) {
  const prefix = "Spec Factory certification source.\n";
  if (bytes <= prefix.length) return prefix.slice(0, bytes);
  return `${prefix}${"x".repeat(bytes - prefix.length)}`;
}

function requiredEnv(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(__ENV[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
