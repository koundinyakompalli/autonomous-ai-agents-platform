/**
 * S3 Storage Utility
 *
 * Handles uploading and downloading agent results to/from S3
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../utils/awsClients.js';
import { createLogger } from '../utils/logger.js';
import {
  deriveTicketEvidenceKey,
  type TicketEvidenceV1,
} from '../oneshot/ticket-evidence.js';

const logger = createLogger('orchestrator');

export interface StorageConfig {
  region?: string;
  bucketPrefix?: string;
}

/**
 * S3 Storage Manager
 */
export class Storage {
  private s3Client: S3Client;
  private bucketPrefix: string;
  private taskBucket: string;
  private resultBucket: string;

  constructor(config?: StorageConfig) {
    this.s3Client = createS3Client({
      region: config?.region || process.env.AWS_REGION || 'us-east-1',
    });
    // Use S3_BUCKET_PREFIX from environment (set by Terraform)
    this.bucketPrefix = config?.bucketPrefix || process.env.S3_BUCKET_PREFIX || 'specter';
    this.taskBucket = `${this.bucketPrefix}-tasks`;
    this.resultBucket = `${this.bucketPrefix}-results`;
  }

  /**
   * Get bucket name for agent results (all agents use same bucket)
   */
  getBucketName(agentName: string): string {
    return this.resultBucket;
  }

  /**
   * Get task bucket name
   */
  getTaskBucket(): string {
    return this.taskBucket;
  }

  /**
   * Generate S3 key for result (includes agent name in path)
   */
  generateResultKey(taskId: number, jiraNumber: string, agentName: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `results/${agentName.toLowerCase()}/${jiraNumber}/${taskId}-${timestamp}.md`;
  }

  /**
   * Generate S3 key for task description
   */
  generateTaskKey(jiraNumber: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `tasks/${jiraNumber}/${timestamp}.md`;
  }

  /**
   * Upload task description to S3
   */
  async uploadTaskDescription(
    jiraNumber: string,
    content: string
  ): Promise<{ bucket: string; key: string }> {
    const bucket = this.getTaskBucket();
    const key = this.generateTaskKey(jiraNumber);

    logger.info( {
      jira: jiraNumber,
      bucket,
      key,
      size: content.length,
    },'Uploading task description to S3');

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'text/markdown',
        Metadata: {
          jiraNumber: jiraNumber,
          uploadedAt: new Date().toISOString(),
          type: 'task_description',
        },
      });

      await this.s3Client.send(command);

      logger.info( {
        jira: jiraNumber,
        bucket,
        key,
      },'Task description uploaded to S3');

      return { bucket, key };
    } catch (error) {
      logger.error( {
        jira: jiraNumber,
        bucket,
        key,
        error,
      },'Failed to upload task description to S3');
      throw error;
    }
  }

  async uploadTicketEvidence(
    jiraNumber: string,
    taskDescriptionKey: string,
    evidence: TicketEvidenceV1
  ): Promise<{ bucket: string; key: string }> {
    const bucket = this.getTaskBucket();
    const key = deriveTicketEvidenceKey(taskDescriptionKey);

    logger.info({
      jira: jiraNumber,
      bucket,
      key,
      commentCount: evidence.stats.commentCount,
      attachmentCount: evidence.stats.attachmentCount,
      warningCount: evidence.stats.warningCount,
    }, 'Uploading ticket evidence to S3');

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(evidence, null, 2),
        ContentType: 'application/json',
        Metadata: {
          jiraNumber,
          uploadedAt: new Date().toISOString(),
          type: 'ticket_evidence_v1',
          schemaVersion: evidence.schemaVersion,
        },
      });

      await this.s3Client.send(command);

      logger.info({
        jira: jiraNumber,
        bucket,
        key,
      }, 'Ticket evidence uploaded to S3');

      return { bucket, key };
    } catch (error) {
      logger.error({
        jira: jiraNumber,
        bucket,
        key,
        error,
      }, 'Failed to upload ticket evidence to S3');
      throw error;
    }
  }

  /**
   * Upload result to S3
   */
  async uploadResult(
    agentName: string,
    taskId: number,
    jiraNumber: string,
    content: string
  ): Promise<{ bucket: string; key: string }> {
    const bucket = this.getBucketName(agentName);
    const key = this.generateResultKey(taskId, jiraNumber, agentName);

    logger.info( {
      agent: agentName,
      bucket,
      key,
      size: content.length,
    },'Uploading result to S3');

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'text/markdown',
        Metadata: {
          agent: agentName,
          taskId: taskId.toString(),
          jiraNumber: jiraNumber,
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      logger.info( {
        agent: agentName,
        bucket,
        key,
      },'Result uploaded to S3');

      return { bucket, key };
    } catch (error) {
      logger.error( {
        agent: agentName,
        bucket,
        key,
        error,
      },'Failed to upload to S3');
      throw error;
    }
  }

  /**
   * Download result from S3
   */
  async downloadResult(bucket: string, key: string): Promise<string> {
    logger.debug( { bucket, key },'Downloading result from S3');

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('Empty response body from S3');
      }

      const content = await response.Body.transformToString();

      logger.debug( {
        bucket,
        key,
        size: content.length,
      },'Result downloaded from S3');

      return content;
    } catch (error) {
      logger.error( { bucket, key, error },'Failed to download from S3');
      throw error;
    }
  }
}

// Singleton instance
let storageInstance: Storage | null = null;

/**
 * Get storage instance (singleton)
 */
export function getStorage(config?: StorageConfig): Storage {
  if (!storageInstance) {
    storageInstance = new Storage(config);
  }
  return storageInstance;
}
