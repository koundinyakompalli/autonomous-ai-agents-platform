import { useEffect, useRef, useState } from "react";
import {
  validateCreateRun,
} from "./newRunApi.js";
import type {
  OneShotCreateRunMode,
  OneShotRunRequestValidation,
} from "./types.js";

type PaletteStep = "input" | "validating" | "confirm";

export function CommandPalette({
  open,
  mode,
  isBusy = false,
  errorMessage = null,
  onClose,
  onResetError,
  onCreateRun,
}: {
  open: boolean;
  mode: OneShotCreateRunMode;
  isBusy?: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onResetError?: () => void;
  onCreateRun: (validation: OneShotRunRequestValidation) => Promise<void> | void;
}) {
  const [jiraKey, setJiraKey] = useState("");
  const [step, setStep] = useState<PaletteStep>("input");
  const [validation, setValidation] = useState<OneShotRunRequestValidation | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const validationRequestRef = useRef(0);

  const isValidating = step === "validating";
  const isPaletteBusy = isBusy || isValidating;
  const displayError = validationError ?? errorMessage;

  useEffect(() => {
    if (open) {
      const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(focusTimer);
    }
    validationRequestRef.current += 1;
    setJiraKey("");
    setStep("input");
    setValidation(null);
    setValidationError(null);
  }, [open]);

  if (!open) return null;

  function requestClose(): void {
    if (isPaletteBusy) {
      return;
    }
    onClose();
  }

  function resetToInput(nextKey?: string): void {
    validationRequestRef.current += 1;
    if (typeof nextKey === "string") {
      setJiraKey(nextKey);
    }
    setStep("input");
    setValidation(null);
    setValidationError(null);
    onResetError?.();
  }

  async function validate(): Promise<void> {
    const normalized = jiraKey.trim().toUpperCase();
    if (!normalized || isPaletteBusy) return;

    onResetError?.();
    setValidationError(null);
    setStep("validating");

    const requestId = validationRequestRef.current + 1;
    validationRequestRef.current = requestId;

    try {
      const result = await validateCreateRun(mode, normalized);
      if (validationRequestRef.current !== requestId) {
        return;
      }

      setJiraKey(result.jiraKey);
      setValidation(result);
      setStep("confirm");
    } catch (error) {
      if (validationRequestRef.current !== requestId) {
        return;
      }

      setStep("input");
      setValidation(null);
      setValidationError(
        error instanceof Error ? error.message : "Jira validation failed",
      );
    }
  }

  async function submit(): Promise<void> {
    if (step === "confirm") {
      if (!validation || isPaletteBusy) return;
      await onCreateRun(validation);
      return;
    }

    await validate();
  }

  function handleJiraKeyChange(value: string): void {
    if (step !== "input" || validationError || errorMessage) {
      resetToInput(value);
      return;
    }
    setJiraKey(value);
  }

  return (
    <div className="palette-backdrop" onClick={requestClose}>
      <div
        className="palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="oneshot-command-palette"
      >
        <div className="palette-head">
          <span className="palette-prompt mono" id="oneshot-command-palette">
            oneshot ▸
          </span>
          <input
            ref={inputRef}
            value={jiraKey}
            onChange={(event) => handleJiraKeyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                requestClose();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              mode === "mock"
                ? "Enter Jira key to create a local mock run…"
                : "Enter Jira key to validate before queueing…"
            }
            className="palette-input"
            disabled={isPaletteBusy}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>

        <div className="palette-list" style={{ gap: 10 }}>
          {step !== "confirm" && (
            <>
              <div className="palette-empty" style={{ textAlign: "left" }}>
                {mode === "mock"
                  ? "Validate locally before creating a synthetic dashboard run."
                  : "Validate the Jira ticket before adding it to the queue."}
              </div>
              <div className="palette-empty dim" style={{ textAlign: "left" }}>
                {mode === "mock"
                  ? "Mock mode stays local to the dashboard and does not talk to Jira."
                  : "After confirmation, the backend queues QUALIFIER and tracks the request until a real OneShot run exists."}
              </div>
              <div className="palette-empty dim" style={{ textAlign: "left" }}>
                {mode === "mock"
                  ? "A synthetic title will be used for the mock row."
                  : "Existing OneShot runs for the same Jira key are still rejected."}
              </div>
            </>
          )}

          {step === "confirm" && validation && (
            <>
              <div className="palette-empty" style={{ textAlign: "left" }}>
                {mode === "mock"
                  ? "Confirm local mock run creation."
                  : "Confirm this Jira ticket before adding it to the queue."}
              </div>
              <div
                className="palette-empty dim"
                style={{ textAlign: "left", display: "grid", gap: 6 }}
              >
                <div>
                  <span className="mono">key</span>: {validation.jiraKey}
                </div>
                <div>
                  <span className="mono">title</span>: {validation.title}
                </div>
                <div>
                  <span className="mono">status</span>: {validation.statusName}
                </div>
              </div>
              <div className="palette-empty dim" style={{ textAlign: "left" }}>
                {mode === "mock"
                  ? "This creates a synthetic local row immediately."
                  : "QUALIFIER remains the readiness gate after this ticket is queued."}
              </div>
            </>
          )}

          {displayError && (
            <div
              className="palette-empty"
              style={{ textAlign: "left", color: "var(--bad)" }}
            >
              {displayError}
            </div>
          )}
        </div>

        <div
          className="palette-foot"
          style={{ justifyContent: "space-between", alignItems: "center" }}
        >
          <div className="mono dim" style={{ display: "flex", gap: 14 }}>
            <span>
              <span className="kbd-inline">↵</span>{" "}
              {step === "confirm"
                ? mode === "mock"
                  ? "create"
                  : "queue"
                : "validate"}
            </span>
            <span>
              <span className="kbd-inline">esc</span> dismiss
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {step === "confirm" && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => resetToInput()}
                disabled={isPaletteBusy}
              >
                <span>back</span>
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submit()}
              disabled={isPaletteBusy || jiraKey.trim().length === 0}
            >
              <span>
                {isPaletteBusy
                  ? "…"
                  : step === "confirm"
                    ? mode === "mock"
                      ? "create mock run"
                      : "add to queue"
                    : "validate"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
