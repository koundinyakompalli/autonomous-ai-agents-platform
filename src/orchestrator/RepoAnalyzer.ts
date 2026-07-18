/**
 * Repository Analyzer
 * 
 * Uses LLM to analyze JIRA ticket content and determine which code repositories
 * should be investigated for the task.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from '../utils/logger.js';
import type { CodeRepository } from './database.js';

const logger = createLogger('orchestrator');

type TicketFamily = 'mp' | 'cp' | 'unknown';

const REPO_GUIDANCE_BY_NAME: Record<string, string[]> = {
    'core-app': [
        'Primary UI, APIs, and business-layer code.',
        'Default repo for general CP application behavior when nothing more specific is isolated.',
    ],
    'client-services': [
        'Customer-specific implementations and integrations.',
        'Good fit for CPCLIENT or customer-specific implementation work.',
    ],
    'batch-jobs': [
        'Scheduled jobs, intake jobs, queue processing, correspondence, assessments, and workflow batch logic.',
    ],
    'provider-portal': [
        'Provider-facing secondary application.',
        'Use when the ticket explicitly refers to Provider Portal behavior.',
    ],
    'React-based-new-ui': [
        'React UI surface for newer application areas including OCR and MD review screens.',
    ],
    'interop': [
        'CP interoperability monorepo.',
        'Use for interoperability, FHIR, CDS Hooks, payer/provider API exchange, and external integration work.',
    ],
    'data-visor': [
        'Data Visor / data lake pipeline repository.',
        'Use for data lake, Data Visor, reference table validation, reporting query support, and data pipeline work.',
    ],
    'Ai-agents': [
        'Enterprise AI Agent Platform repository for controller agents, processing agents, MCP servers, code intelligence, Terraform-managed AWS agent hosting, shared SDKs, and the UI portal.',
        'For this healthcare SaaS platform, preserve the repo safety rules: controllers decide orchestration, processing agents execute only, no PHI in logs, security failures fail closed, production service-to-service traffic uses HTTPS, and infrastructure changes stay in Terraform/IaC.',
        'Prefer this repo for tickets mentioning enterprise-ai-agent-platform, controller agents, processing agents, agent hosting, MCP servers, orchestration core, code intelligence, or platform Terraform.',
    ],
    'Document-ai': [
        'Document OCR, extraction, and intake services.',
    ],
    'mp-web': [
        'MP web application repository.',
        'Prefer for MP web, release-note, or client-note style tickets.',
    ],
    'mp-product-client-configs': [
        'MP product and client configuration repository.',
        'Prefer for MP config, tenant config, feature flags, YAML/JSON/properties, or client-configuration changes.',
    ],
};

const MP_CONFIG_KEYWORDS = [
    'config',
    'configuration',
    'tenant',
    'client config',
    'client-config',
    'product config',
    'product-config',
    'feature flag',
    'feature-flag',
    'yaml',
    'yml',
    'json',
    'properties',
    'manifest',
    'override',
    'settings',
];

const MP_WEB_KEYWORDS = [
    'release note',
    'release notes',
    'client note',
    'client notes',
    'release version',
    'release',
    'version',
    'web',
    'website',
    'portal',
    'notary',
    'ui',
];

interface JiraIssue {
    key: string;
    fields: {
        summary: string;
        description: string;
        [key: string]: any;
    };
}

interface RepoAnalysisResult {
    selectedRepoIds: number[];
    reasoning: string;
}

export class RepoAnalyzer {
    private bedrockClient: BedrockRuntimeClient;
    private modelId: string;

    constructor(options?: { modelId?: string; region?: string }) {
        this.bedrockClient = new BedrockRuntimeClient({
            region: options?.region || process.env.AWS_REGION || 'us-east-2',
        });
        this.modelId = options?.modelId || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    }

    /**
     * Analyze JIRA ticket and determine which repositories to investigate
     */
    async analyzeTicketForRepos(
        jiraIssue: JiraIssue,
        availableRepos: CodeRepository[]
    ): Promise<RepoAnalysisResult> {
        logger.info( { jira: jiraIssue.key },'Analyzing ticket for relevant repos');

        const descriptionText = this.extractDescription(jiraIssue.fields.description);
        const ticketText = this.buildTicketText(jiraIssue, descriptionText);
        const ticketFamily = this.detectTicketFamily(jiraIssue.key, ticketText);
        const candidateRepos = this.filterCandidateRepos(ticketFamily, availableRepos);

        const ruleBasedResult = this.tryRuleBasedSelection(
            jiraIssue,
            candidateRepos,
            ticketFamily,
            ticketText,
        );

        if (ruleBasedResult) {
            logger.info( {
                jira: jiraIssue.key,
                ticketFamily,
                selectedRepoIds: ruleBasedResult.selectedRepoIds,
                candidateRepoNames: candidateRepos.map(repo => repo.repo_name),
            },'Repo analysis resolved by deterministic rules');
            return ruleBasedResult;
        }

        try {
            const prompt = this.buildAnalysisPrompt(
                jiraIssue,
                candidateRepos,
                ticketFamily,
                descriptionText,
            );
            const response = await this.callBedrock(prompt);
            const result = this.parseResponse(response, candidateRepos, ticketFamily);

            logger.info( {
                jira: jiraIssue.key,
                ticketFamily,
                selectedRepoIds: result.selectedRepoIds,
            },'Repo analysis complete');

            return result;
        } catch (error) {
            logger.error( { jira: jiraIssue.key, error },'Failed to analyze ticket for repos');
            return this.buildFallbackResult(
                candidateRepos,
                ticketFamily,
                'Failed to analyze - using deterministic fallback',
            );
        }
    }

    /**
     * Build the analysis prompt
     */
    private buildAnalysisPrompt(
        jiraIssue: JiraIssue,
        candidateRepos: CodeRepository[],
        ticketFamily: TicketFamily,
        descriptionText: string,
    ): string {
        const repoList = this.buildRepoContext(candidateRepos);
        const coreAppAvailable = candidateRepos.some(repo => repo.repo_name === 'core-app');
        const familyInstruction = this.getFamilyInstruction(ticketFamily);
        const coreAppInstruction = coreAppAvailable && ticketFamily !== 'mp'
            ? 'If nothing else is clearly isolated, include core-app.'
            : 'Only select from the candidate repositories listed above.';

        return `You are a code repository analyst for a healthcare software company (MedHok).
Your job is to analyze JIRA tickets and determine which code repositories are most relevant for investigation.

Candidate Repositories:
=======================
${repoList}

JIRA Ticket to Analyze:
=======================
Key: ${jiraIssue.key}
Summary: ${jiraIssue.fields.summary}
Description: ${descriptionText}

Ticket Family Hint:
===================
${familyInstruction}

Instructions:
1. Read the ticket carefully
2. Identify keywords, features, or components mentioned
3. Select the most relevant repositories (typically 1-3)
4. ${coreAppInstruction}
5. Respond in JSON format only

Response Format (JSON only):
{
  "selectedRepoIds": [1, 2],
  "reasoning": "Brief explanation of why these repos were selected"
}

Analyze the ticket and respond with JSON:`;
    }

    /**
     * Extract description text from JIRA content
     */
    private extractDescription(description: any): string {
        if (!description) return 'No description provided';

        // If it's a string, return as-is
        if (typeof description === 'string') return description;

        // If it's ADF (Atlassian Document Format), extract text
        if (description.content) {
            return this.extractTextFromADF(description);
        }

        return JSON.stringify(description);
    }

    /**
     * Extract plain text from Atlassian Document Format
     */
    private extractTextFromADF(adf: any): string {
        const texts: string[] = [];

        const extractText = (node: any) => {
            if (node.text) {
                texts.push(node.text);
            }
            if (node.content) {
                node.content.forEach(extractText);
            }
        };

        extractText(adf);
        return texts.join(' ');
    }

    /**
     * Build normalized ticket text for deterministic matching.
     */
    private buildTicketText(jiraIssue: JiraIssue, descriptionText: string): string {
        return [
            jiraIssue.key || '',
            jiraIssue.fields.summary || '',
            descriptionText || '',
        ].join('\n');
    }

    /**
     * Detect whether the ticket belongs to MP, CP, or an unknown family.
     */
    private detectTicketFamily(jiraKey: string, ticketText: string): TicketFamily {
        const directProjectKey = this.extractProjectKey(jiraKey);
        if (directProjectKey?.startsWith('MP')) return 'mp';
        if (directProjectKey?.startsWith('CP')) return 'cp';

        const referencedProjectKeys = Array.from(
            ticketText.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g),
            match => match[1],
        );

        if (referencedProjectKeys.some(projectKey => projectKey.startsWith('MP'))) {
            return 'mp';
        }
        if (referencedProjectKeys.some(projectKey => projectKey.startsWith('CP'))) {
            return 'cp';
        }

        return 'unknown';
    }

    /**
     * Restrict candidate repos by ticket family so MP and CP work do not cross-contaminate.
     */
    private filterCandidateRepos(
        ticketFamily: TicketFamily,
        availableRepos: CodeRepository[],
    ): CodeRepository[] {
        if (ticketFamily === 'mp') {
            const mpRepos = availableRepos.filter(repo => this.isMpRepo(repo));
            return mpRepos.length > 0 ? mpRepos : availableRepos;
        }

        if (ticketFamily === 'cp') {
            const nonMpRepos = availableRepos.filter(repo => !this.isMpRepo(repo));
            return nonMpRepos.length > 0 ? nonMpRepos : availableRepos;
        }

        return availableRepos;
    }

    /**
     * Apply simple deterministic rules before falling back to the LLM path.
     */
    private tryRuleBasedSelection(
        jiraIssue: JiraIssue,
        candidateRepos: CodeRepository[],
        ticketFamily: TicketFamily,
        ticketText: string,
    ): RepoAnalysisResult | null {
        if (candidateRepos.length === 0) {
            return null;
        }

        if (ticketFamily !== 'mp') {
            return null;
        }

        const normalizedText = ticketText.toLowerCase();
        const configRepo = candidateRepos.find(repo => repo.repo_name === 'mp-product-client-configs');
        const mpWebRepo = candidateRepos.find(repo => repo.repo_name === 'mp-web');

        if (configRepo && this.containsAnyKeyword(normalizedText, MP_CONFIG_KEYWORDS)) {
            return {
                selectedRepoIds: [configRepo.id],
                reasoning: `MP ticket ${jiraIssue.key} mentions configuration-related work; routing to mp-product-client-configs.`,
            };
        }

        if (mpWebRepo && this.containsAnyKeyword(normalizedText, MP_WEB_KEYWORDS)) {
            return {
                selectedRepoIds: [mpWebRepo.id],
                reasoning: `MP ticket ${jiraIssue.key} looks web or release-note related; routing to mp-web.`,
            };
        }

        const mpRepoIds = candidateRepos
            .filter(repo => this.isMpRepo(repo))
            .map(repo => repo.id);

        if (mpRepoIds.length > 0) {
            return {
                selectedRepoIds: mpRepoIds,
                reasoning: `MP ticket family detected for ${jiraIssue.key}; selecting MP-specific repositories until finer-grained per-repo rules are added.`,
            };
        }

        return null;
    }

    /**
     * Build repo context dynamically from the current repository catalog.
     */
    private buildRepoContext(candidateRepos: CodeRepository[]): string {
        if (candidateRepos.length === 0) {
            return 'No repositories available.';
        }

        return candidateRepos.map(repo => {
            const details = [
                repo.description?.trim(),
                repo.default_branch ? `Default branch: ${repo.default_branch}` : null,
                ...(REPO_GUIDANCE_BY_NAME[repo.repo_name] || []),
            ].filter(Boolean) as string[];

            return [
                `${repo.id}. ${repo.repo_name} (ID: ${repo.id})`,
                ...details.map(detail => `   - ${detail}`),
            ].join('\n');
        }).join('\n\n');
    }

    /**
     * Human-readable family guidance for the LLM.
     */
    private getFamilyInstruction(ticketFamily: TicketFamily): string {
        switch (ticketFamily) {
            case 'mp':
                return 'This ticket belongs to the MP project family. Prefer MP-specific repositories only.';
            case 'cp':
                return 'This ticket belongs to the CP project family. Prefer CP and shared application repositories.';
            default:
                return 'Ticket family is unknown. Use the candidate repository list and ticket content to decide.';
        }
    }

    /**
     * Choose a deterministic fallback if the LLM path fails.
     */
    private buildFallbackResult(
        candidateRepos: CodeRepository[],
        ticketFamily: TicketFamily,
        reason: string,
    ): RepoAnalysisResult {
        if (ticketFamily === 'mp') {
            const mpRepoIds = candidateRepos
                .filter(repo => this.isMpRepo(repo))
                .map(repo => repo.id);
            if (mpRepoIds.length > 0) {
                return {
                    selectedRepoIds: mpRepoIds,
                    reasoning: `${reason}. Falling back to MP-specific repositories.`,
                };
            }
        }

        const coreApp = candidateRepos.find(repo => repo.repo_name === 'core-app');
        if (coreApp) {
            return {
                selectedRepoIds: [coreApp.id],
                reasoning: `${reason}. Falling back to core-app.`,
            };
        }

        if (candidateRepos[0]) {
            return {
                selectedRepoIds: [candidateRepos[0].id],
                reasoning: `${reason}. Falling back to the first available candidate repository.`,
            };
        }

        return {
            selectedRepoIds: [],
            reasoning: `${reason}. No candidate repositories were available.`,
        };
    }

    /**
     * Check if a repository belongs to the MP repo family.
     */
    private isMpRepo(repo: CodeRepository): boolean {
        return repo.repo_name.toLowerCase().startsWith('mp-');
    }

    /**
     * Extract the project key portion of a JIRA key.
     */
    private extractProjectKey(jiraKey: string): string | null {
        if (!jiraKey || !jiraKey.includes('-')) {
            return null;
        }

        const [projectKey] = jiraKey.toUpperCase().split('-', 1);
        return projectKey || null;
    }

    /**
     * Match any keyword in normalized text.
     */
    private containsAnyKeyword(normalizedText: string, keywords: string[]): boolean {
        return keywords.some(keyword => {
            const keywordPattern = keyword
                .toLowerCase()
                .trim()
                .split(/[\s-]+/)
                .map(part => this.escapeRegex(part))
                .join('[-\\s]+');
            const regex = new RegExp(`(^|[^a-z0-9])${keywordPattern}([^a-z0-9]|$)`, 'i');
            return regex.test(normalizedText);
        });
    }

    /**
     * Escape a string for safe use inside a regular expression.
     */
    private escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Call Bedrock API
     */
    private async callBedrock(prompt: string): Promise<string> {
        const payload = {
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 5000,
            temperature: 0.3,
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };

        const command = new InvokeModelCommand({
            modelId: this.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        const response = await this.bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        return responseBody.content[0].text;
    }

    /**
     * Parse LLM response into structured result
     */
    private parseResponse(
        response: string,
        candidateRepos: CodeRepository[],
        ticketFamily: TicketFamily,
    ): RepoAnalysisResult {
        try {
            // Try to extract JSON from response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No JSON found in response');
            }

            const parsed = JSON.parse(jsonMatch[0]);

            // Validate repo IDs
            const validRepoIds = candidateRepos.map(r => r.id);
            const selectedRepoIds = parsed.selectedRepoIds
                .filter((id: number) => validRepoIds.includes(id));

            const coreApp = candidateRepos.find(repo => repo.repo_name === 'core-app');
            if (
                ticketFamily !== 'mp'
                && coreApp
                && !selectedRepoIds.includes(coreApp.id)
            ) {
                selectedRepoIds.unshift(coreApp.id);
            }

            return {
                selectedRepoIds,
                reasoning: parsed.reasoning || 'No reasoning provided',
            };
        } catch (error) {
            logger.warn( { error, response },'Failed to parse repo analysis response');
            return this.buildFallbackResult(
                candidateRepos,
                ticketFamily,
                'Parse error while reading repo analysis response',
            );
        }
    }
}
