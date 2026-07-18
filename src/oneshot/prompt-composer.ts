import { createLogger } from "../utils/logger.js";
import type { IPromptLoader } from "./prompt-loader.js";
import { STAGE_PROMPT_MAP } from "./prompt-types.js";

const logger = createLogger("oneshot-prompt-composer");

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

export class PromptComposer {
  constructor(
    private readonly loader: IPromptLoader,
    private readonly config: { healthcareGuardrailsEnabled: boolean },
  ) {}

  /**
   * Compose a full prompt for a pipeline stage by:
   *  1. Loading the prompt template
   *  2. Interpolating {{variables}}
   *  3. Appending stage guardrails
   *  4. Optionally appending healthcare guardrails
   */
  async composePrompt(
    stage: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const mapping = STAGE_PROMPT_MAP[stage];
    if (!mapping) {
      throw new Error(
        `Unknown OneShot stage "${stage}". Valid stages: ${Object.keys(STAGE_PROMPT_MAP).join(", ")}`,
      );
    }

    const [promptTemplate, guardrailText] = await Promise.all([
      this.loader.loadPrompt(mapping.prompt),
      this.loader.loadGuardrail(mapping.guardrail),
    ]);

    let healthcareText = "";
    if (this.config.healthcareGuardrailsEnabled) {
      healthcareText = await this.loader.loadGuardrail("healthcare-rules");
    }

    const interpolated = this.interpolate(promptTemplate, variables);

    const sections = [interpolated];

    sections.push("\n\n---\n\n## Guardrails\n\n" + guardrailText);

    if (healthcareText) {
      sections.push("\n\n---\n\n## Healthcare Guardrails\n\n" + healthcareText);
    }

    logger.debug(
      {
        stage,
        promptAsset: mapping.prompt,
        guardrailAsset: mapping.guardrail,
        healthcare: this.config.healthcareGuardrailsEnabled,
        variableCount: Object.keys(variables).length,
      },
      "Composed prompt for stage",
    );

    return sections.join("");
  }

  /**
   * Load the system-prompt asset for a stage, if one is configured.
   *
   * Returns `undefined` for stages that don't declare a `systemPrompt`
   * asset in STAGE_PROMPT_MAP — those stages continue to use a single
   * user-turn prompt via `composePrompt`.
   *
   * The returned text is intended for `runAgent({ systemAppend })`,
   * which wraps it as the `append` portion of the SDK's `claude_code`
   * preset. Guardrails are NOT duplicated here — they remain appended
   * to the user-turn prompt by `composePrompt`.
   */
  async composeSystemPrompt(stage: string): Promise<string | undefined> {
    const mapping = STAGE_PROMPT_MAP[stage];
    if (!mapping) {
      throw new Error(
        `Unknown OneShot stage "${stage}". Valid stages: ${Object.keys(STAGE_PROMPT_MAP).join(", ")}`,
      );
    }

    if (!mapping.systemPrompt) return undefined;

    // System prompts are static — no {{placeholder}} interpolation. Any ticket
    // data must flow through the user-turn prompt so it cannot influence the
    // planner's behavioral rules or leak into a different stage's system slot.
    const systemText = await this.loader.loadPrompt(mapping.systemPrompt);

    logger.debug(
      {
        stage,
        systemPromptAsset: mapping.systemPrompt,
        systemPromptBytes: systemText.length,
      },
      "Composed system prompt for stage",
    );

    return systemText;
  }

  /**
   * Load the security remediation planning extension prompt.
   * Returns undefined if the asset is not available (e.g. local dev without the file).
   * The caller appends this to the system prompt only when the ticket is PFOS-labeled.
   */
  async loadSecurityPlanningExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("plan-security-remediation");
    } catch {
      logger.debug("Security planning extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the required retrofit workflow fragment.
   *
   * Retrofit proof is safety-critical: callers request this only for retrofit
   * runs, and missing assets must fail closed instead of silently falling back
   * to weaker generic implementation instructions.
   */
  async loadRetrofitWorkflowPrompt(): Promise<string> {
    return this.loader.loadPrompt("retrofit-workflow");
  }

  /**
   * Load the security remediation review extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadSecurityReviewExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("review-security-remediation");
    } catch {
      logger.debug("Security review extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the Wiz Code (SAST) planning extension prompt.
   * Returns undefined if the asset is not available.
   * The caller appends this to the system prompt only when the ticket is WIZ-CODE-labeled
   * (source-code SAST findings — distinct from the dependency-bump security extension).
   */
  async loadWizCodePlanningExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("plan-wiz-code-remediation");
    } catch {
      logger.debug("Wiz Code planning extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the Wiz Code (SAST) review extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadWizCodeReviewExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("review-wiz-code-remediation");
    } catch {
      logger.debug("Wiz Code review extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the Wiz Code (SAST) code-review extension prompt (final implementation
   * review stage). Returns undefined if the asset is not available.
   */
  async loadWizCodeCodeReviewExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("code-review-wiz-code-remediation");
    } catch {
      logger.debug("Wiz Code code-review extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the SonarQube planning extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadSonarPlanningExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("plan-sonarqube-remediation");
    } catch {
      logger.debug("SonarQube planning extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the SonarQube review extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadSonarReviewExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("review-sonarqube-remediation");
    } catch {
      logger.debug("SonarQube review extension not available — skipping");
      return undefined;
    }
  }

  /**
   * Load the SonarQube implementation extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadSonarImplementationExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("implement-sonarqube-remediation");
    } catch {
      logger.debug(
        "SonarQube implementation extension not available — skipping",
      );
      return undefined;
    }
  }

  /**
   * Load the SonarQube code-review extension prompt.
   * Returns undefined if the asset is not available.
   */
  async loadSonarCodeReviewExtension(): Promise<string | undefined> {
    try {
      return await this.loader.loadPrompt("code-review-sonarqube-remediation");
    } catch {
      logger.debug("SonarQube code-review extension not available — skipping");
      return undefined;
    }
  }

  private interpolate(
    template: string,
    variables: Record<string, string>,
  ): string {
    const result = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
      if (name in variables) {
        return variables[name];
      }
      return `{{${name}}}`;
    });

    const unresolved = [...result.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
    if (unresolved.length > 0) {
      throw new Error(
        `Unresolved placeholders in prompt template: ${[...new Set(unresolved)].join(", ")}`,
      );
    }

    return result;
  }
}
