/**
 * RIFT Output Schema - Structured output for upgrade defect analysis
 */

export const RIFT_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        // Executive summary for non-technical stakeholders
        executive_summary: {
            type: 'object',
            properties: {
                issue_description: { type: 'string' },
                repository_name: { type: 'string' },
                root_cause_simple: { type: 'string' },
                impact: { type: 'string' },
                fix_summary: { type: 'string' },
                estimated_fix_time: { type: 'string' },
            },
            required: ['issue_description', 'repository_name', 'root_cause_simple', 'impact', 'fix_summary'],
        },

        // Version information
        version_comparison: {
            type: 'object',
            properties: {
                old_version: { type: 'string' },
                new_version: { type: 'string' },
                repository_type: { type: 'string' },
                configuration_same: { type: 'boolean' },
            },
            required: ['old_version', 'new_version', 'repository_type'],
        },

        // Top 3 root causes (ranked)
        top_root_causes: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
                type: 'object',
                properties: {
                    rank: { type: 'number', minimum: 1, maximum: 3 },

                    classification: {
                        type: 'string',
                        enum: [
                            'missing_retrofit',
                            'breaking_enhancement',
                            'removed_code',
                            'other',
                        ],
                    },

                    confidence: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        description: 'Confidence score (0-100%)',
                    },

                    summary: { type: 'string' },

                    // Commit details (for code changes)
                    commit: {
                        type: 'object',
                        properties: {
                            hash: { type: 'string' },
                            author: { type: 'string' },
                            date: { type: 'string' },
                            message: { type: 'string' },
                            jira_ticket: { type: 'string' },
                        },
                    },

                    // Code difference
                    code_diff: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            old_version_code: { type: 'string' },
                            new_version_code: { type: 'string' },
                            line_numbers_old: {
                                type: 'object',
                                properties: {
                                    start: { type: 'number' },
                                    end: { type: 'number' },
                                },
                            },
                            line_numbers_new: {
                                type: 'object',
                                properties: {
                                    start: { type: 'number' },
                                    end: { type: 'number' },
                                },
                            },
                            diff_summary: { type: 'string' },
                        },
                    },

                    // Explanation
                    explanation: {
                        type: 'object',
                        properties: {
                            how_it_works_in_old: { type: 'string' },
                            why_it_fails_in_new: { type: 'string' },
                            evidence: { type: 'string' },
                            validation_performed: { type: 'string' },
                        },
                        required: ['how_it_works_in_old', 'why_it_fails_in_new', 'evidence'],
                    },

                    // Fix recommendation
                    fix_recommendation: {
                        type: 'object',
                        properties: {
                            approach: {
                                type: 'string',
                                enum: ['cherry_pick', 'code_patch', 'revert', 'manual_fix'],
                            },
                            commands: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                            patch: { type: 'string' },
                            testing_notes: { type: 'string' },
                        },
                        required: ['approach'],
                    },
                },
                required: ['rank', 'classification', 'confidence', 'summary', 'explanation', 'fix_recommendation'],
            },
        },

        // Additional missing retrofits found during analysis
        additional_missing_retrofits: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    file_path: { type: 'string' },
                    commit_hash: { type: 'string' },
                    commit_message: { type: 'string' },
                    author: { type: 'string' },
                    date: { type: 'string' },
                    jira_ticket: { type: 'string' },
                    risk_level: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                    },
                    description: { type: 'string' },
                },
                required: ['file_path', 'commit_hash', 'risk_level', 'description'],
            },
        },

        // Git analysis summary
        git_analysis: {
            type: 'object',
            properties: {
                commits_in_old_not_in_new: { type: 'number' },
                commits_in_new_not_in_old: { type: 'number' },
                files_analyzed: {
                    type: 'array',
                    items: { type: 'string' },
                },
                validation_checks_performed: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
        },

        // Testing recommendations
        testing_recommendations: {
            type: 'array',
            items: { type: 'string' },
        },

        // Optional config queries to run when DB is unavailable and config values
        // would materially change root cause confidence. Generated at end of RCA.
        config_queries: {
            type: 'object',
            properties: {
                purpose: {
                    type: 'string',
                    description: 'Why these queries are needed — which hypothesis they validate',
                },
                queries: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            label: { type: 'string', description: 'Short name for the query' },
                            sql: { type: 'string', description: 'The SELECT query to run' },
                            confirms_defect: {
                                type: 'string',
                                description: 'What result means the defect IS triggered',
                            },
                            excludes_defect: {
                                type: 'string',
                                description: 'What result means this cause is NOT the issue',
                            },
                            root_cause_rank: {
                                type: 'number',
                                description: 'Which top_root_causes rank this query validates (1, 2, or 3)',
                            },
                        },
                        required: ['label', 'sql', 'confirms_defect', 'excludes_defect'],
                    },
                },
                instructions: {
                    type: 'string',
                    description: 'Instructions for the developer — how to run queries and share results',
                },
            },
            required: ['purpose', 'queries', 'instructions'],
        },
    },
    required: [
        'executive_summary',
        'version_comparison',
        'top_root_causes',
    ],
};

export default RIFT_OUTPUT_SCHEMA;
