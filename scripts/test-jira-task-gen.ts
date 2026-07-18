#!/usr/bin/env npx tsx
/**
 * Test script for enhanced JIRA Client
 *
 * Usage:
 *   npx tsx scripts/test-jira-task-gen.ts <JIRA-KEY> [--raw|--llm]
 *
 * Options:
 *   --raw   Output raw JIRA data as markdown (no LLM, fast)
 *   --llm   Use Bedrock LLM to generate structured task description (default)
 *
 * Environment variables required:
 *   JIRA_BASE_URL  - e.g., https://your-domain.atlassian.net
 *   JIRA_USERNAME  - Your Atlassian email
 *   JIRA_TOKEN     - Your Atlassian API token
 *
 * For LLM mode also requires:
 *   AWS_REGION     - AWS region for Bedrock
 *   AWS credentials configured
 *
 * Examples:
 *   npx tsx scripts/test-jira-task-gen.ts MHK-12345
 *   npx tsx scripts/test-jira-task-gen.ts MHK-12345 --raw
 *   npx tsx scripts/test-jira-task-gen.ts MHK-12345 --llm
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { createJiraClient, adfToMarkdown, type JiraTicketData, type ImageAttachment } from '../src/orchestrator/JiraClient.js';
import { TaskDescriptionGenerator } from '../src/orchestrator/TaskDescriptionGenerator.js';

// =============================================================================
// Configuration
// =============================================================================

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ Missing required environment variable: ${name}`);
        console.error(`   Please set it in your .env file or environment`);
        process.exit(1);
    }
    return value;
}

// =============================================================================
// Raw Markdown Generator (No LLM)
// =============================================================================

function generateRawMarkdown(data: JiraTicketData, outputDir?: string): string {
    const { issue, descriptionMarkdown, comments, attachments, textAttachments, imageAttachments } = data;

    const lines: string[] = [];

    // Header
    lines.push(`# ${issue.key}: ${issue.fields.summary || 'No Summary'}`);
    lines.push('');

    // Metadata
    lines.push('## Ticket Metadata');
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Key** | ${issue.key} |`);
    lines.push(`| **Type** | ${issue.fields.issuetype?.name || 'Unknown'} |`);
    lines.push(`| **Status** | ${issue.fields.status?.name || 'Unknown'} |`);
    lines.push(`| **Priority** | ${issue.fields.priority?.name || 'Unknown'} |`);
    lines.push(`| **Resolution** | ${issue.fields.resolution?.name || 'Unresolved'} |`);
    lines.push(`| **Reporter** | ${issue.fields.reporter?.displayName || 'Unknown'} |`);
    lines.push(`| **Assignee** | ${issue.fields.assignee?.displayName || 'Unassigned'} |`);
    lines.push(`| **Created** | ${issue.fields.created || 'Unknown'} |`);
    lines.push(`| **Updated** | ${issue.fields.updated || 'Unknown'} |`);
    lines.push(`| **Labels** | ${(issue.fields.labels || []).join(', ') || 'None'} |`);
    lines.push(`| **Components** | ${(issue.fields.components || []).map(c => c.name).join(', ') || 'None'} |`);
    lines.push(`| **Fix Versions** | ${(issue.fields.fixVersions || []).map(v => v.name).join(', ') || 'None'} |`);
    lines.push('');

    // Parent/Epic link
    if (issue.fields.parent) {
        lines.push(`**Parent**: [${issue.fields.parent.key}] ${issue.fields.parent.fields?.summary || ''}`);
        lines.push('');
    }

    // Description
    lines.push('## Description');
    lines.push('');
    if (descriptionMarkdown) {
        lines.push(descriptionMarkdown);
    } else {
        lines.push('*(No description provided)*');
    }
    lines.push('');

    // Issue Links
    const issueLinks = issue.fields.issuelinks || [];
    if (issueLinks.length > 0) {
        lines.push('## Linked Issues');
        lines.push('');
        for (const link of issueLinks) {
            if (link.inwardIssue) {
                lines.push(`- **${link.type?.inward}**: [${link.inwardIssue.key}] ${link.inwardIssue.fields?.summary || ''}`);
            }
            if (link.outwardIssue) {
                lines.push(`- **${link.type?.outward}**: [${link.outwardIssue.key}] ${link.outwardIssue.fields?.summary || ''}`);
            }
        }
        lines.push('');
    }

    // Subtasks
    const subtasks = issue.fields.subtasks || [];
    if (subtasks.length > 0) {
        lines.push('## Subtasks');
        lines.push('');
        for (const subtask of subtasks) {
            const status = subtask.fields?.status?.name || 'Unknown';
            lines.push(`- [${status}] **${subtask.key}**: ${subtask.fields?.summary || ''}`);
        }
        lines.push('');
    }

    // Comments
    lines.push(`## Comments (${comments.length})`);
    lines.push('');
    if (comments.length === 0) {
        lines.push('*(No comments)*');
    } else {
        for (let i = 0; i < comments.length; i++) {
            const comment = comments[i];
            lines.push(`### Comment #${i + 1}`);
            lines.push('');
            lines.push(`**Author**: ${comment.author || 'Unknown'}  `);
            lines.push(`**Date**: ${comment.created}`);
            lines.push('');
            if (comment.bodyMarkdown) {
                lines.push(comment.bodyMarkdown);
            } else {
                lines.push('*(Empty comment)*');
            }
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    // Attachments
    lines.push(`## Attachments (${attachments.length})`);
    lines.push('');
    if (attachments.length === 0) {
        lines.push('*(No attachments)*');
    } else {
        lines.push('| Filename | Type | Size | Author | Created |');
        lines.push('|----------|------|------|--------|---------|');
        for (const att of attachments) {
            const size = att.size ? `${(att.size / 1024).toFixed(1)} KB` : 'Unknown';
            lines.push(`| ${att.filename} | ${att.mimeType || 'Unknown'} | ${size} | ${att.author?.displayName || 'Unknown'} | ${att.created || ''} |`);
        }
        lines.push('');
    }

    // Text Attachment Contents
    if (textAttachments.length > 0) {
        lines.push('## Downloaded Text Attachments');
        lines.push('');
        for (const textAtt of textAttachments) {
            lines.push(`### 📄 ${textAtt.filename}`);
            lines.push('');
            lines.push(`*Type: ${textAtt.mimeType || 'unknown'} | Size: ${textAtt.size} bytes*`);
            lines.push('');
            lines.push('```');
            lines.push(textAtt.content);
            lines.push('```');
            lines.push('');
        }
    }

    // Image Attachments
    if (imageAttachments.length > 0) {
        lines.push('## Downloaded Image Attachments');
        lines.push('');

        // Save images to output directory if provided
        if (outputDir) {
            const imagesDir = path.join(outputDir, 'images');
            fs.mkdirSync(imagesDir, { recursive: true });

            for (const img of imageAttachments) {
                const imagePath = path.join(imagesDir, img.filename);
                const buffer = Buffer.from(img.base64Data, 'base64');
                fs.writeFileSync(imagePath, buffer);

                // Add markdown image reference (relative path)
                lines.push(`### 🖼️ ${img.filename}`);
                lines.push('');
                lines.push(`*Type: ${img.mimeType} | Original size: ${(img.originalSize / 1024).toFixed(1)} KB*`);
                lines.push('');
                lines.push(`![${img.filename}](images/${img.filename})`);
                lines.push('');
            }
            lines.push(`*Images saved to: ${imagesDir}*`);
        } else {
            // Just list the images without saving
            for (const img of imageAttachments) {
                lines.push(`### 🖼️ ${img.filename}`);
                lines.push('');
                lines.push(`*Type: ${img.mimeType} | Original size: ${(img.originalSize / 1024).toFixed(1)} KB*`);
                lines.push('');
                lines.push(`*(Base64 data available - ${(img.base64Data.length / 1024).toFixed(1)} KB encoded)*`);
                lines.push('');
            }
        }
        lines.push('');
    }

    // Footer
    lines.push('---');
    lines.push('');
    lines.push(`*Generated by Specter JIRA Client at ${new Date().toISOString()}*`);

    return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    // Parse arguments
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: npx ts-node scripts/test-jira-task-gen.ts <JIRA-KEY> [--raw|--llm]

Options:
  --raw   Output raw JIRA data as markdown (no LLM, fast)
  --llm   Use Bedrock LLM to generate structured task description (default)

Environment variables:
  JIRA_BASE_URL  - JIRA Cloud URL (e.g., https://your-domain.atlassian.net)
  JIRA_USERNAME  - Atlassian email
  JIRA_TOKEN     - Atlassian API token
  AWS_REGION     - AWS region for Bedrock (only for --llm mode)

Examples:
  npx ts-node scripts/test-jira-task-gen.ts MHK-12345
  npx ts-node scripts/test-jira-task-gen.ts MHK-12345 --raw
`);
        process.exit(0);
    }

    const issueKey = args.find(a => !a.startsWith('--'));
    if (!issueKey) {
        console.error('❌ Please provide a JIRA issue key');
        process.exit(1);
    }

    const useRaw = args.includes('--raw');
    const useLlm = args.includes('--llm') || !useRaw;

    console.log(`\n🎫 JIRA Ticket: ${issueKey}`);
    console.log(`📝 Mode: ${useRaw ? 'RAW (no LLM)' : 'LLM (Bedrock)'}`);
    console.log('');

    // Validate environment
    const jiraBaseUrl = requireEnv('JIRA_BASE_URL');
    const jiraUsername = requireEnv('JIRA_USERNAME');
    const jiraToken = requireEnv('JIRA_TOKEN');

    console.log(`🔗 JIRA Base URL: ${jiraBaseUrl}`);
    console.log(`👤 Username: ${jiraUsername}`);
    console.log('');

    // Create JIRA client
    const jiraClient = createJiraClient({
        baseUrl: jiraBaseUrl,
        username: jiraUsername,
        token: jiraToken,
        maxAttachmentBytes: 200_000, // 200KB max per attachment
    });

    // Fetch JIRA data
    console.log(`📥 Fetching JIRA ticket data for ${issueKey}...`);
    const startTime = Date.now();

    let ticketData: JiraTicketData;
    try {
        ticketData = await jiraClient.fetchTicketData(issueKey);
    } catch (error) {
        console.error(`\n❌ Failed to fetch JIRA ticket: ${error}`);
        process.exit(1);
    }

    const fetchTime = Date.now() - startTime;
    console.log(`✅ Fetched in ${fetchTime}ms`);
    console.log(`   - Description: ${ticketData.descriptionMarkdown.length} chars`);
    console.log(`   - Comments: ${ticketData.comments.length}`);
    console.log(`   - Attachments: ${ticketData.attachments.length} total`);
    console.log(`     • Text files downloaded: ${ticketData.textAttachments.length}`);
    console.log(`     • Images downloaded: ${ticketData.imageAttachments.length}`);
    console.log('');

    // Create output directory early for image saving
    const outputDir = path.resolve(process.cwd(), 'out');
    fs.mkdirSync(outputDir, { recursive: true });

    // Generate markdown
    let markdown: string;

    if (useRaw) {
        console.log('📄 Generating raw markdown...');
        markdown = generateRawMarkdown(ticketData, outputDir);
    } else {
        console.log('🤖 Generating task description via Bedrock LLM...');

        // Validate AWS config for LLM mode
        if (!process.env.AWS_REGION) {
            console.warn('⚠️  AWS_REGION not set, defaulting to us-east-1');
        }

        const generator = new TaskDescriptionGenerator({
            jiraBaseUrl,
            jiraUsername,
            jiraToken,
            awsRegion: process.env.AWS_REGION || 'us-east-1',
        });

        try {
            markdown = await generator.generateFromTicketKey(issueKey);
        } catch (error) {
            console.error(`\n❌ Failed to generate task description: ${error}`);
            console.log('\n💡 Tip: Falling back to raw mode...\n');
            markdown = generateRawMarkdown(ticketData);
        }
    }

    const totalTime = Date.now() - startTime;

    // Write output file
    const outputPath = path.join(outputDir, `${issueKey}.md`);
    fs.writeFileSync(outputPath, markdown, 'utf8');

    console.log(`\n✅ Output written to: ${outputPath}`);
    console.log(`   - Size: ${(markdown.length / 1024).toFixed(1)} KB`);
    console.log(`   - Total time: ${totalTime}ms`);
    console.log('');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
