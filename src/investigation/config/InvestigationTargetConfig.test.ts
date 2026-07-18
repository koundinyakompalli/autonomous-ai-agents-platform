import { describe, expect, it } from 'vitest'
import { loadInvestigationTargetConfig } from './InvestigationTargetConfig.js'

describe('loadInvestigationTargetConfig log sources', () => {
  it('normalizes CloudWatch and S3 archive source definitions', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        logSources: [
          {
            id: 'humana-core',
            clientId: 'HUMANA',
            environment: 'prod-replica',
            kind: 'cloudwatch',
            logGroupTemplate: '/CP/{clientId}/{envId}/core',
            envId: 'PROD1',
            filterPattern: '?ERROR ?Exception',
            maxEvents: 7,
          },
          {
            id: 'humana-batch-archive',
            clientId: 'HUMANA',
            environment: 'PROD_REPLICA',
            kind: 's3_archive',
            bucket: 'com.medhok.recursive-archiver',
            prefixTemplate: '{clientId}/{envId}/',
            maxObjects: 25,
          },
          {
            id: 'invalid-s3-missing-prefix',
            clientId: 'HUMANA',
            environment: 'PROD_REPLICA',
            kind: 's3_archive',
            bucket: 'com.medhok.recursive-archiver',
          },
        ],
      }),
    } as NodeJS.ProcessEnv)

    expect(config.logSources).toEqual([
      expect.objectContaining({
        id: 'humana-core',
        environment: 'PROD_REPLICA',
        kind: 'cloudwatch',
        logGroupTemplate: '/CP/{clientId}/{envId}/core',
        filterPattern: '?ERROR ?Exception',
        maxEvents: 7,
        enabled: true,
      }),
      expect.objectContaining({
        id: 'humana-batch-archive',
        environment: 'PROD_REPLICA',
        kind: 's3_archive',
        bucket: 'com.medhok.recursive-archiver',
        prefixTemplate: '{clientId}/{envId}/',
        maxObjects: 25,
        optional: true,
        enabled: true,
      }),
    ])
  })

  it('normalizes approved host config probe paths', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        hostTargets: [
          {
            id: 'performrx-uat-core',
            clientId: 'PERFORMRX',
            environment: 'uat',
            envId: 'UAT1',
            instanceId: 'i-123',
            instanceName: 'performrx-uat-core',
            region: 'us-east-2',
            configProbePaths: ['/opt/app/config', '/usr/local/tomcat/conf'],
            configProbeMaxMatches: 12,
          },
        ],
      }),
    } as NodeJS.ProcessEnv)

    expect(config.hostTargets).toEqual([
      expect.objectContaining({
        id: 'performrx-uat-core',
        environment: 'UAT',
        configProbePaths: ['/opt/app/config', '/usr/local/tomcat/conf'],
        configProbeMaxMatches: 12,
      }),
    ])
  })

  it('normalizes public SSH operator LDAP host targets', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        hostTargets: [
          {
            id: 'performrx-uat-batch',
            clientId: 'PERFORMRX',
            environment: 'uat',
            envId: 'UAT1',
            instanceId: 'i-123',
            instanceName: 'performrxuatbatch',
            region: 'us-east-2',
            networkPath: 'ssh_public',
            publicIp: '203.0.113.86',
            sshPort: 22,
            sshUser: 'vgedela',
            sshAuthMode: 'operator_ldap',
            sshAllowed: true,
            ssmAllowed: false,
          },
        ],
      }),
    } as NodeJS.ProcessEnv)

    expect(config.hostTargets).toEqual([
      expect.objectContaining({
        id: 'performrx-uat-batch',
        environment: 'UAT',
        networkPath: 'ssh_public',
        publicHost: '203.0.113.86',
        sshPort: 22,
        sshUser: 'vgedela',
        sshAuthMode: 'operator_ldap',
        sshAllowed: true,
        ssmAllowed: false,
      }),
    ])
  })

  it('normalizes operator LDAP SSH database connection targets', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        connections: [
          {
            id: 'wellcare-prod-local-tunnel',
            clientId: 'WELLCARE',
            environment: 'prod-replica',
            host: '127.0.0.1',
            port: 3332,
            networkPath: 'ldap_ssh',
            dbUser: 'env://INVESTIGATION_DB_USERNAME',
            secretRef: 'env://INVESTIGATION_DB_PASSWORD',
          },
        ],
      }),
    } as NodeJS.ProcessEnv)

    expect(config.connections).toEqual([
      expect.objectContaining({
        id: 'wellcare-prod-local-tunnel',
        environment: 'PROD_REPLICA',
        networkPath: 'ssh_public',
        host: '127.0.0.1',
        port: 3332,
      }),
    ])
  })

  it('normalizes code semantic profiles for configured code ranking', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        codeSemanticProfiles: [
          {
            id: 'epa_eappeal_response',
            title: 'ePA eAppeal response support',
            summary: 'Rank ePA response code paths ahead of schema-only matches.',
            clientId: 'PERFORMRX',
            environments: ['uat'],
            priority: 100,
            matchAll: ['epa', 'e appeal'],
            matchAny: ['PAResponse', 'IsEAppealSupported'],
            preferredTerms: ['IsEAppealSupported', 'PAResponse'],
            pathBoosts: ['response'],
            previewBoosts: ['iseappealsupported'],
            negativePathTerms: ['fixture'],
            rules: [
              {
                score: 22,
                reason: 'PAResponse with EPA context',
                textAll: ['PAResponse'],
                textAny: ['EPA'],
              },
            ],
            dataDiagnostics: [
              {
                id: 'appcode_epa_eappeal_config_validation',
                description: 'Code-derived DER/ePA configuration diagnostic.',
                environments: ['uat'],
                allowedTables: ['epa_config', 'der_defaults_epa_config'],
                parameterNames: [],
                sql: 'SELECT COUNT(*) AS total_rows FROM epa_config LIMIT 1',
                maxRows: 1,
                timeoutMs: 5000,
                redactionTags: ['application_code_derived', 'config_only'],
                sourceFiles: ['MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/DerDefaultsEpaConfig.hbm.xml'],
              },
            ],
          },
          {
            id: 'invalid-no-terms',
            title: 'Invalid',
          },
        ],
      }),
    } as NodeJS.ProcessEnv)

    expect(config.codeSemanticProfiles).toEqual([
      expect.objectContaining({
        id: 'epa_eappeal_response',
        clientId: 'PERFORMRX',
        environments: ['UAT'],
        priority: 100,
        preferredTerms: ['IsEAppealSupported', 'PAResponse'],
        enabled: true,
        rules: [
          expect.objectContaining({
            score: 22,
            reason: 'PAResponse with EPA context',
            textAll: ['PAResponse'],
            textAny: ['EPA'],
          }),
        ],
        dataDiagnostics: [
          expect.objectContaining({
            id: 'appcode_epa_eappeal_config_validation',
            environments: ['UAT'],
            allowedTables: ['epa_config', 'der_defaults_epa_config'],
            sourceFiles: ['MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/DerDefaultsEpaConfig.hbm.xml'],
          }),
        ],
      }),
    ])
  })

  it('normalizes bounded serverless evidence defaults and client overrides', () => {
    const config = loadInvestigationTargetConfig({
      INVESTIGATION_TARGETS_JSON: JSON.stringify({
        serverlessEvidence: {
          defaults: {
            services: ['lambda', 'sqs', 'not-an-aws-service'],
            maxResources: 100,
            maxRequests: 999,
            maxLogEvents: 500,
            timelineLookbackHours: 999,
            timelineBucketMinutes: 1,
            timelineMaxPagesPerWindow: 99,
            timelineMaxEventsPerWindow: 9_999,
            maxDeploymentPackageBytes: 999999999,
          },
          scopes: [{
            clientId: 'CLIENTX',
            environment: 'prod-replica',
            resourceNameHints: ['legacy-cba'],
            resourceNameExclusions: ['sandbox'],
            regions: ['us-west-2'],
            inspectDeploymentPackages: false,
            maxResources: 4,
            timelineLookbackHours: 48,
          }],
        },
      }),
    } as NodeJS.ProcessEnv)

    expect(config.serverlessEvidence?.defaults).toMatchObject({
      services: ['lambda', 'sqs'],
      maxResources: 25,
      maxRequests: 250,
      maxLogEvents: 200,
      timelineLookbackHours: 336,
      timelineBucketMinutes: 15,
      timelineMaxPagesPerWindow: 10,
      timelineMaxEventsPerWindow: 2_000,
      maxDeploymentPackageBytes: 52_428_800,
    })
    expect(config.serverlessEvidence?.scopes).toEqual([
      expect.objectContaining({
        clientId: 'CLIENTX',
        environment: 'PROD_REPLICA',
        resourceNameHints: ['legacy-cba'],
        resourceNameExclusions: ['sandbox'],
        regions: ['us-west-2'],
        inspectDeploymentPackages: false,
        maxResources: 4,
        timelineLookbackHours: 48,
        services: ['lambda', 'sqs'],
      }),
    ])
  })
})
