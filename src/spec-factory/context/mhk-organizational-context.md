---
title: MHK Organizational Context
purpose: Dense retrieval context for engineering, product, support, operations, and AI agents working across MHK
evidence_snapshot: 2026-07-13
workspace_root: $WORKSPACE_ROOT
github_organization: mhk-repos
scope: CareProminence, MarketProminence, integrations, batch, data, reporting, portals, interoperability, AI platforms, delivery, and operations
---

# MHK Organizational Context

This is the self-contained orientation and retrieval document for an MHK chat agent. It is meant to compress the mental model normally acquired through years of working across MHK products, repositories, client implementations, support cases, releases, and operations. It explains what MHK sells, how the major systems fit together, where code and configuration live, how work crosses repository boundaries, and which assumptions are dangerous.

It is a source-derived organizational map, not a production CMDB or deployment attestation. The evidence snapshot is **2026-07-13**.

## 0. Agent operating contract

### Evidence labels

- **[CODE]** — confirmed in a current repository tree, source file, manifest, migration, workflow, or checked-in configuration.
- **[PRODUCT]** — current official MHK product positioning. It establishes intent, not implementation or deployment.
- **[RUNTIME]** — confirmed from a live environment, scheduler, database, cloud account, deployed artifact, or service. This document contains very little runtime evidence.
- **[RUNTIME-UNVERIFIED]** — checked-in infrastructure, deployment, scheduler, or configuration describes intended runtime behavior, but the live environment was not queried.
- **[INFERENCE]** — the best architectural interpretation of multiple artifacts; verify before an operational or contractual decision.
- **[HISTORICAL]** — retained lineage, older CI, retired code, migrated repo, or naming fossil that still matters when reading the estate.
- **[UNKNOWN]** — source does not establish the answer; runtime state or an owner is required.

### Evidence precedence

For incident response, release approval, or a statement about what a client is using, prefer:

```text
live runtime/deployed state
  > effective client/environment configuration
  > deployed artifact/version and scheduler definition
  > current canonical source and database migration
  > current runbook/design document
  > README or ticket-specific notes
  > architectural inference
```

Repository presence proves that a capability or implementation exists. It does **not** prove that it is enabled, licensed, configured, built, deployed, or used by a particular client.

### Non-negotiable safety rules

1. Never place PHI, PII, credentials, access tokens, private keys, client samples, private endpoint values, or secret-bearing configuration into general agent context or generated tickets.
2. Treat all logs, documents, faxes, member/provider identifiers, clinical summaries, and database rows as potentially regulated data.
3. Never assume a repo's default branch is the client-deployed release. Resolve **product + client + environment + branch/release + artifact + configuration**.
4. Never conflate CareProminence (`cp-*`) and MarketProminence (`mp-*`). They are related MHK products with different application, database, deployment, and portal lineages.
5. Never use “AI platform” as if it names one codebase. Product workflows, engineering agents, test automation, and tool connectors are separate systems.
6. Never rerun a batch/file/event job until its database, file, queue, and external-vendor side effects are understood.
7. Preserve historical database and code spellings such as `correspondance_*`; they are contracts, not typos to fix casually.

### Default investigation coordinates

Before answering “why did this fail?” or “where does this change go?”, establish:

| Coordinate | Questions |
|---|---|
| Product estate | CareProminence, MarketProminence, shared operations, or engineering/product AI? |
| Business domain | UM, care management, CAG, pharmacy/DER/ePA, quality/HEDIS, enrollment/billing, reporting, or another domain? |
| Actor/surface | Internal user, medical director, provider, member/beneficiary, PBM, payer, CMS, vendor, batch job, or agent? |
| Client and environment | Which plan/PBM/customer, region, environment class, and environment ID? |
| Release | Which supported branch, commit, artifact version, database migration level, and UI bundle? |
| Entry point | UI/BFF, REST/SOAP/FHIR, file, fax/email, X12, scheduler, SQS/SNS, direct SQL, or portal? |
| Configuration | System variables/reference data, client adapter, Terraform tfvars, scheduler XML, job YAML, secrets, or feature permission? |
| Handoff | Which database row, event key, queue, document ID, vendor transaction, output file, or correspondence record joins the stages? |

## 1. Sixty-second MHK mental model

MHK is a healthcare technology company serving health plans, pharmacy benefit managers (PBMs), and managed-care organizations. It was founded as **MedHOK** in 2010, acquired **MarketProminence** in 2015, and joined **Hearst Health** in 2016. The older `medhok` name remains everywhere in packages, schemas, artifact coordinates, URLs, and repository names; “MedHOK” in code generally means lineage, not a third current product. **[PRODUCT, CODE]**

MHK has two long-lived transactional product estates:

- **CareProminence (CP)** — the main clinical and care-operations platform: utilization management, medical and pharmacy prior authorization, care management, complaints/appeals/grievances, correspondence, quality/population health, interoperability, analytics, and increasingly AI-assisted workflows.
- **MarketProminence (MP)** — a separate Medicare administrative platform: enrollment/member maintenance, premium billing, financial reconciliation, and staff/broker/beneficiary portals.

MHK also publicly offers **SmartProminence Orchestrator** as a standalone, cross-product AI orchestration layer that does not require CareProminence or MarketProminence. That public offering is distinct from the repository informally called the SmartProminence React app. `enterprise-ai-agent-platform` is the strongest inspected implementation candidate for product-facing orchestration, but the exact brand-to-deployment mapping requires product-owner or runtime confirmation. **[PRODUCT, CODE, UNKNOWN]**

The **CareProminence Core App** is `cp-medhok-monorepo`. It is the transactional and workflow center of CareProminence. It combines a large Java/Spring/Hibernate/jBPM application, the legacy GWT/SmartGWT UI, a newer BFF used by React, REST/SOAP services, FHIR support, shared models, and Flyway migrations.

The estate surrounding Core App is not peripheral. It is how the product actually operates:

- `cp-mhk-smart-prominence` is the modern React CareProminence UI, informally the **SmartProminence React app** or **smart UI**; it calls Core App's `/bff` rather than replacing the backend and is not the whole public Orchestrator offering.
- `cp-batch-monorepo` contains independently built scheduled jobs for intake, fax/OCR, correspondence, ePA, X12, workflows, extracts, alerts, and client processing.
- `cp-client-services-monorepo` contains payer/PBM/vendor-specific service adapters selected behind shared Core interfaces.
- scheduler XML (`cp-product-scheduler-times`) controls **when/where** jobs run; client YAML (`cp-product-client-configs`) controls **what** they do.
- `cp-configurations` is the per-client/per-environment Terraform input plane for many newer services.
- `cp-interoperability-monorepo` implements FHIR/Da Vinci/SMART/HealthLake exchange around Core.
- data extract, datamart, DataVisor/data-lake, Jasper/Knowage/Spago, HEDIS, and compliance repositories turn transactional data into operations, regulatory outputs, and analytics.
- `enterprise-ai-agent-platform` implements checked-in product-facing durable LLM/agent workflows and is the primary inspected Orchestrator implementation candidate; `cp-autonomous-ai-agents-platform` (Specter) automates engineering/support work; other AI repos have narrower roles. Live deployment and public-brand mapping remain unverified.

The recurring CareProminence business pattern is:

```text
intake
  -> validate, classify, match, and enrich
  -> create or attach to member/case
  -> route/assign workflow and task
  -> clinical or operational review
  -> criteria/evidence assessment
  -> decision/resolution
  -> effectuation and correspondence
  -> audit, compliance, reporting, and downstream exchange
```

Client behavior is often created by the combination of shared code, client adapter, reference/system-variable data, templates, schedules, Terraform inputs, and vendor configuration. In MHK, **configuration is part of the product**.

## 2. Canonical identity and alias map

| Name an MHK person may use | Canonical meaning | Primary repository or source |
|---|---|---|
| MHK | Company/product organization; formerly MedHOK | Product context plus the `mhk-repos` GitHub organization |
| MedHOK / Medhok | Historical company/product namespace retained in code, DB, packages, artifacts, hosts | Widespread `com.medhok.*`, `medhok-*`, `mm-*` naming |
| CP / CareProminence | Clinical/care management product estate | Predominantly `cp-*` repositories |
| Core App / core / medhok-monorepo | Main CareProminence transaction/workflow application | `cp-medhok-monorepo` |
| MedicalMgmt / medical-mgmt | Main legacy UI/server WAR inside Core | `cp-medhok-monorepo/MedicalMgmt` |
| Core models / model | Shared Hibernate entities/mappings | `cp-medhok-monorepo/MedicalMgmtModels` and related model artifacts |
| Web services / WS | Core REST and SOAP API surface | `cp-medhok-monorepo/medhok-web-services` |
| SmartProminence Orchestrator | Public standalone/cross-product healthcare AI orchestration offering; no CP/MP dependency in current product positioning | `enterprise-ai-agent-platform` is the primary inspected implementation candidate; exact brand/runtime mapping is **[UNKNOWN]** |
| SmartProminence React app / smart UI | Modern React CareProminence SPA; repository nickname, not the whole public Orchestrator offering | `cp-mhk-smart-prominence` |
| Batch | Independently built scheduled/async applications | `cp-batch-monorepo` plus scheduler/config and utilities |
| Client Services | Client, payer, PBM, and vendor adapters | `cp-client-services-monorepo` |
| Provider Portal | Separate CP provider-facing Java application family | `cp-provider-portal` |
| Interop | FHIR/Da Vinci/SMART/HealthLake integration estate | `cp-interoperability-monorepo` and smaller Core FHIR surfaces |
| DataVisor | CareProminence analytics product/capability | `cp-datalake-pipeline`, datamarts, QuickSight/reporting repos; product name is broader than one repo |
| Document AI | Document/fax extraction workflow; several implementation generations | `enterprise-ai-agent-platform`, `cp-batch-monorepo/medhok-ocr-manager`, SmartProminence React app, and standalone `document-ai` lineage |
| Enterprise platform / enterprise AI | Checked-in product-facing clinical/document workflow implementation and Orchestrator candidate | `enterprise-ai-agent-platform`; deployment/brand mapping requires confirmation |
| Specter | Engineering/support agent platform | `cp-autonomous-ai-agents-platform`; a local `Specter` clone is not a second product |
| Harvey | Teams-facing engineering/support entry point within Specter | `cp-autonomous-ai-agents-platform/src/harvey` |
| OneShot / PFOS | Automated ticket-to-draft-PR delivery pipeline in Specter; also a separate Python lineage exists | Specter plus distinct `mhk-project-one-shot` |
| Spec Factory | Requirements-to-Jira composition and drafting subsystem | `cp-autonomous-ai-agents-platform/src/spec-factory` |
| MP / MarketProminence | Enrollment, billing, reconciliation, portal product estate | `mp-*` repositories |
| Skybot / Automate Scheduler | Enterprise job scheduler/control plane | Job XML in `cp-product-scheduler-times`; live scheduler is separate |
| InfAuto | Infrastructure Automation estate and shared job/file/host runners | `infauto-*` repositories and deployed tooling |
| Spago / SpagoBI / Knowage | Embedded/operational BI engine generations | CP Spago/Knowage repos plus report/datamart/catalog assets |

## 3. Product and business-domain model

### 3.1 CareProminence solution families

| Domain | What the business is trying to do | Common implementation surfaces |
|---|---|---|
| Utilization Management (UM) | Receive and review prior-authorization requests, apply benefits and medical-necessity rules, manage inpatient/concurrent/post-service review, route tasks, make determinations, and meet turnaround times | Core `MedicalMgmt` authorization/review services and UI; BFF/Smart UI MD review; web services; X12/FHIR/provider intake; InterQual/MCG; correspondence; batch |
| Care Management (CM) | Coordinate longitudinal member care, assessments, care plans, programs, goals/interventions, outreach, assignments, and disease/case-management work | Core member/care-plan/assessment/program services; offline/mobile variants; alerts, batch, reporting |
| Complaints, Appeals and Grievances (CAG) | Process medical/pharmacy appeals, grievances, CMS complaints, external review/IRE, provider disputes, quality-of-care, root cause and regulatory deadlines | Core appeal/grievance/CTM/IRE/QOC/provider-dispute domains; correspondence; external-review integrations; compliance reports |
| Pharmacy Management | Process drug exception requests, coverage determinations/redeterminations, medical- and pharmacy-benefit drug requests, ePA, test claims, PBM effectuation, MTM and overutilization | Core DER/RxPA/ePA, PBM adapters, NCPDP/ePA schedulers/gateways, pharmacy APIs, correspondence, reports |
| Population Health and Quality | Stratify risk, identify care gaps, manage registries/campaigns, calculate quality measures, and support HEDIS/CAHPS/NCQA work | Core population/quality domains, `cp-hedis-monorepo`, data lake/datamarts, batch campaigns, reports |
| Interoperability | Exchange data and prior-authorization workflows using FHIR, Da Vinci CRD/DTR/PAS, SMART on FHIR, X12, events, and client APIs | `cp-interoperability-monorepo`, Core APIs/FHIR, event publishing, client adapters, X12 batch |
| DataVisor and reporting | Measure volume, timeliness, throughput, staffing, compliance, outcomes, and client/regulatory performance | Datalake/Redshift/QuickSight, domain datamarts, Jasper/Knowage/Spago, extracts, compliance reports |

Public product intent is described at [MHK solutions](https://mhk.com/), [UM](https://mhk.com/solutions/mhk-careprominence/utilization-management-suite/), [Care Management](https://mhk.com/solutions/mhk-careprominence/care-management-suite/), [CAG](https://mhk.com/solutions/mhk-careprominence/complaints-appeals-and-grievances-suite/), [Pharmacy](https://mhk.com/solutions/mhk-careprominence/pharmacy-management-suite/), [Population Health](https://mhk.com/solutions/mhk-careprominence/population-health-quality-management/), [Interop](https://mhk.com/solutions/mhk-careprominence/mhk-interop-suite/), and [DataVisor](https://mhk.com/solutions/mhk-careprominence/data-visor-insights-and-analytics-for-payers/). **[PRODUCT]**

### 3.2 SmartProminence Orchestrator

Current public positioning describes SmartProminence Orchestrator as a standalone AI foundation for coordinating governed, multi-agent healthcare workflows across existing systems, including systems outside MHK. Public use cases include document intake, clinical-review preparation, policy conversion, case-manager call preparation, and compliance/SLA monitoring. Those are product-intent claims, not proof of a client deployment or of a one-to-one repository mapping. **[PRODUCT]**

The inspected `enterprise-ai-agent-platform` implements the closest matching durable orchestration concepts—workflow definitions/DAGs, controller and processing agents, SQS dispatch, artifacts, audit and usage tracking, human-reviewable healthcare/document workflows, and a separate administration portal. Treat it as the primary implementation candidate, not a confirmed exclusive mapping to the public brand. The `cp-mhk-smart-prominence` React repository is a CareProminence operator UI and must be named explicitly as the **SmartProminence React app** when that is what is meant. **[CODE, UNKNOWN]**

### 3.3 MarketProminence solution families

| Domain | Purpose | Repository shape |
|---|---|---|
| Enrollment and member maintenance | Electronic/paper application intake, eligibility/election validation, CMS submission/response, changes and disenrollment | Oracle/PLSQL core plus `.NET`/TypeScript enrollment portals and integration utilities |
| Premium billing | Premium calculation, member/group billing, remittance, payment integration, account status and self-service | MP Oracle core plus C# API and TypeScript/HTML portal family |
| Financial reconciliation | Reconcile member-level CMS payments, eligibility/enrollment and risk data; handle forecasts and retroactive adjustments | `mp-web`, PL/SQL core/APIs, reporting/utilities |
| Web portals | Staff/broker enrollment and beneficiary self-service | Enrollment, beneficiary, and premium-billing portal repo families |

MarketProminence has its own Oracle database and PL/SQL center (`mp-core-database`), `.NET` web/API applications, TypeScript portal UIs, client-interface/config repositories, Jenkins/Ansible deployment, and OCI Terraform. CP's Java/MySQL/AWS assumptions do not automatically apply. **[CODE]**

### 3.4 Domain vocabulary

| Term | Meaning in MHK context |
|---|---|
| Member | Covered person at the center of CP workflows; connected to eligibility, LOB, benefits, providers, cases, claims, care plans, documents, and correspondence |
| LOB | Line of business; a critical configuration and eligibility partition, often represented through company/company LOB/account structures |
| Authorization / auth / PA | Request to approve a service or item; can be medical, pharmacy, inpatient, outpatient, prospective, concurrent, or retrospective |
| UM | Utilization Management |
| CM | Care Management |
| CAG | Complaints, Appeals and Grievances suite/domain |
| CAGM | Client/PBM vocabulary seen in pharmacy adapters for coverage/appeal/grievance management APIs; interpret in adapter context |
| DER | Drug Exception Request, the core CareProminence pharmacy-case domain |
| CD / RD | Coverage Determination / Redetermination; pharmacy benefit review stages represented in DER/ePA configuration and reporting |
| ePA / EPA | Electronic Prior Authorization, especially NCPDP-oriented pharmacy exchanges; do not confuse with the general medical prior-authorization concept |
| PBM | Pharmacy Benefit Manager; external administrator/system for drug benefits, eligibility, pharmacy claims, test claims, prior auth and effectuation depending on client |
| Effectuation | Applying an approved/changed decision to the external benefit/claims system and reconciling its response |
| Test claim | Prospective pharmacy claim/adjudication call used to understand coverage, price, reject codes, or override behavior |
| MTM | Medication Therapy Management |
| OMS | Overutilization Monitoring System, including opioid/CARA monitoring workflows and reporting |
| CTM | CMS complaint tracking/module vocabulary used in CAG workflows |
| IRE | Independent Review Entity / external review workflow, commonly in appeals and pharmacy/medical review |
| QOC | Quality of Care issue/workflow |
| Provider dispute | Provider-facing dispute/reconsideration workflow; separate from, but connected to, appeals/CAG |
| HEDIS | Healthcare Effectiveness Data and Information Set quality-measure program |
| CAHPS | Consumer Assessment of Healthcare Providers and Systems survey/output family |
| IDSS / DCAP | NCQA/HEDIS submission and data-completeness artifacts represented in the HEDIS repo |
| ODAG / CDAG | Organization Determinations, Appeals and Grievances / Coverage Determinations, Appeals and Grievances regulatory report families |
| InterQual | External clinical-criteria/review product integrated into authorization and appeal/review experiences |
| MCG / CareWebQI | MCG clinical-guideline/review integration; CareWebQI is a major application/integration name in the code |
| BFF | Backend for Frontend. Core's Spring controllers/services provide session-aware APIs for the SmartProminence React app |
| GWT / SmartGWT | Legacy browser UI technology used by the main CareProminence application; still business-critical |
| FHIR | HL7 Fast Healthcare Interoperability Resources; CP uses R4/R4B paths across Core and Interop |
| CRD / DTR / PAS | Da Vinci Coverage Requirements Discovery, Documentation Templates and Rules, and Prior Authorization Support |
| SMART on FHIR | OAuth-based application launch/authorization pattern around FHIR servers |
| X12 278 | Healthcare services review/prior-authorization request/response transaction |
| X12 834 / 835 / 837 | Enrollment, remittance, and claim transaction families appearing in utilities/import/integration code |
| Correspondence | Generated letters/notices plus print/fax/email/SMS delivery, tracking, acknowledgements, and compliance; effectively a platform of its own |
| Incoming image | Fax/scanned/uploaded document intake object feeding OCR/classification/case workflows |
| DataVisor | MHK analytics product/capability; implementation spans data lake, materialized views, QuickSight, datamarts, and related tooling |
| System variable | Database-held feature/behavior switch or value used throughout Core; often client/environment-specific |
| Reference/config table | Database data that controls workflow/business semantics; not merely lookup display text |
| Client adapter | A client/PBM/vendor-specific implementation behind shared service/callout interfaces |
| Command set / `CONFIG_KEY` | Scheduler/InfAuto vocabulary that selects a configured job runner and its environment-specific YAML |

## 4. Whole-system architecture

```text
 Actors and inbound channels
 internal users | medical directors | providers | members | PBMs | CMS | vendors
       |              |                  |         |       |       |
       +-- legacy UI / Smart UI ---------+         |       |       |
       +-- Provider/MP portals --------------------+       |       |
       +-- REST/SOAP/FHIR/SMART/X12/files/fax/email/events --------+
                                      |
                                      v
                        CareProminence Core App
                  cp-medhok-monorepo / client MySQL
        GWT + BFF + services + domain model + workflow + Flyway
              |                |                 |
              |                |                 +--> correspondence/effectuation
              |                +--> PBM/payer/vendor adapters
              |                     cp-client-services-monorepo
              +--> shared schema/APIs/events
                        |
       +----------------+--------------------+------------------+
       |                |                    |                  |
       v                v                    v                  v
 batch/import/OCR   interoperability    product AI         data/reporting
 schedulers/files   FHIR/HealthLake     workflows          DMS/Redshift/QS
 X12/correspond.    Da Vinci/SMART      Document AI        datamarts/Jasper
       |                |                    |                  |
       +----------------+--------------------+------------------+
                                      |
                                      v
                    audit, compliance, monitoring, exports

 Separate product estate:
 MarketProminence = Oracle/PLSQL core + .NET web/APIs + TypeScript portals

 Engineering/support plane:
 Specter/Harvey/OneShot/Spec Factory + MCP tools + GitHub/Jira/Teams/AWS/DB evidence
```

### 4.1 Persistent and integration centers

- **CareProminence client MySQL databases** are both product state and a de facto integration contract. Core, batch, adapters, extracts, reports, and data-lake replication can all depend on the schema. **[CODE]**
- **Core REST/SOAP/BFF services** are the main synchronous application boundary. Not all older integrations use them; many jobs still use direct SQL or shared model artifacts. **[CODE]**
- **Client adapter JARs** plug external semantics into Core behind common service interfaces. Selection is profile/configuration/deployment-specific. **[CODE]**
- **Files and schedulers** remain first-class: X12, CSV, fixed-width, XML, ZIP, PDF, fax images, manifests, acknowledgements and archive/error directories. **[CODE]**
- **SNS/SQS/EventBridge/Lambda/ECS** form the newer asynchronous integration and agent plane, but frequently call back into older Core APIs/schema. **[CODE]**
- **MarketProminence Oracle** is an independent center with PL/SQL packages, tables, views, upgrades, imports and `.NET` consumers. **[CODE]**

## 5. PBMs, pharmacy ePA, portals, InterQual, and MCG

These are first-class product/integration concepts. They cut across UI, Core, client adapters, batch, configuration, external systems, and reporting.

### 5.1 PBM integration model

**PBM has two related meanings here.** MHK serves PBMs as customers/operating organizations, and CareProminence also integrates with PBM systems as external pharmacy-benefit/claims/effectuation edges. A PBM customer could still have multiple downstream systems; a health-plan customer could integrate with a delegated PBM. Do not infer the customer-to-adapter topology from the word “PBM.” **[PRODUCT, CODE]**

PBMs administer pharmacy-benefit operations. In a typical MHK implementation, CareProminence owns the clinical/operational case, workflow, notes, deadlines, correspondence and audit, while a PBM or payer system may own eligibility, benefit detail, claim history, live/test adjudication, prior-authorization profile, override/effectuation, or final downstream claim behavior. The exact system-of-record split is client-specific. **[CODE, INFERENCE]**

The shared-to-specific call chain is:

```text
Core UI or business service
  -> shared ExternalCallout/service interface
  -> selected `mm-service-*` client/PBM adapter JAR
  -> OAuth / WS-Security / mTLS / SOAP / REST as required
  -> PBM or payer endpoint
  -> adapter maps external response to Core model
  -> DER/auth/claim/member UI and workflow
```

`cp-client-services-monorepo` includes multiple generations or client variants for:

- CVS/Caremark: `mm-service-CVS-PBM`, `-v2`, `-v3`, Evolent variant, `mm-service-cvs`, `mm-service-cvs-MMM`;
- ESI/Express Scripts: `mm-service-ESI-PBM`, with Core ESI effectuation UI;
- MedImpact: `mm-service-medimpact`, `mm-service-leonMedimpact`, plus Leon variants;
- Abarca: `mm-service-abarca`, `mm-service-abarca-v2`;
- Tredium: `mm-service-Tredium-PBM`;
- Magellan: `mm-service-magellan`;
- Argus and newer niche partners: `mm-service-ArgusLegacy`, `mm-service-Rightway`, `mm-service-withme`;
- plan/client adapters including `mm-service-Aultcare`, `mm-service-CareSource`, `mm-service-hne`, WellCare, BCBS plans, Aetna, Cigna, Humana, MCS, OneHome, Optum on canonical master, and others.

`mm-rxclaim-service` is an additional shared pharmacy-claim seam. The presence of both broadly named client adapters and explicitly PBM-named modules is why “the PBM integration” cannot be resolved from vendor name alone. **[CODE]**

Common adapter operations include member/eligibility search, pharmacy/medical claims, test claim or estimate, prior-auth submission/read, notes, provider data, benefit/formulary detail, override/effectuation, token acquisition, and response/audit mapping. A repo name does not prove all operations or active use; inspect its `externalcallouts.xml`, service implementation, WSDL/XSD/generated models, and active artifact profile. **[CODE]**

Core also contains PBM-specific UI/configuration variants such as CVS, ESI, Optum, Prime, BSCA, BCBSMA and Argus effectuation views. This illustrates a long-lived MHK pattern: a common pharmacy domain with client/vendor-specific presentation and effectuation semantics. **[CODE]**

### 5.2 Electronic prior authorization (ePA)

“Electronic prior authorization” is an umbrella phrase. In this estate, unqualified **ePA** usually means pharmacy electronic prior authorization around the DER domain and NCPDP-oriented transactions. Medical X12 278, FHIR/Da Vinci PAS, and Provider Portal submission are separate electronic authorization paths with different actors, state models and failure domains. **[CODE]**

Core implementation includes:

- `MedicalMgmt/.../server/service/EPAService.java` for NCPDP ePA configuration, transaction/history/status, bypass/drug-exception and case-match concerns;
- `MedicalMgmt/.../client/admin/EPAConfigWorkSpace.java`, DER/ePA configuration datasources, and `EpaTransactionWorkSpace`;
- persistent models such as `WebServiceTransactionNcpdp`, `NcpdpEpaCaseMatchConfig`, request reasons, transaction status/history, drug exception and bypass configuration;
- `medhok-web-services/.../RxPARestServices.java` and `RxPADAO` for pharmacy prior-auth APIs, including predictive-PA response integration;
- Flyway lineage for NCPDP transaction tables/events/history and DER default ePA configuration;
- correspondence logic for ePA/fax provider communication.

The batch/utility plane includes active and retired generations:

- `epa-schedulers-v2017` and CVS variant coordinate ePA exchanges, including Surescripts/CenterX-related code;
- older `epa-schedulers*` directories are retained and some READMEs mark them retired;
- `epa-servlet-v2017`, `ncpdp-epa-servlet`, `ncpdpmedhokepagateway*`, and `epaReport` provide servlet/gateway/report lineage;
- client/PBM adapters perform eligibility, test claim, prior-auth and effectuation calls.

Common NCPDP ePA transaction families visible in the implementation include `EPAREQ` (request), `EPAANS` (answer), `EPAAPL` (appeal), `EPACAN` (cancel), `EPAERR` (error), and `EPAVER` (verification/status-related exchange). The exact message choreography and supported version are gateway/client-specific. A transport or network acknowledgement proves receipt, not a clinical approval; a timeout proves missing response, not a denial. **[CODE]**

A pharmacy ePA flow is therefore closer to:

```text
inbound ePA transaction or portal/API request
  -> NCPDP gateway/scheduler/adapter
  -> member, drug, eligibility and case-match rules
  -> create/update DER (Drug Exception Request)
  -> coverage determination/redetermination workflow
  -> clinical/operational review and decision
  -> PBM effectuation/override
  -> provider/member communication
  -> transaction history, compliance and reporting
```

Do not call every prior authorization “ePA.” Medical ePA/interoperability flows may use X12 278 or FHIR CRD/DTR/PAS and land in the UM authorization domain rather than DER.

### 5.3 InterQual and MCG/CareWebQI clinical criteria

InterQual and MCG are external clinical-criteria/review integrations used to support medical-necessity review. They are not interchangeable names and are not the Core decision engine itself. Client activation, licensed content, user permissions, URLs, and workflow behavior are configuration-dependent. **[CODE]**

MCG is also a separate sister company to MHK within the Hearst Health network. “External” in this section means external to the CareProminence application/runtime boundary, not unrelated corporate ownership. **[PRODUCT]**

**InterQual path:**

- Core stores and returns authorization-review records and builds/launches InterQual-oriented review experiences.
- `MedicalMgmt/.../server/bff/controllers/InterqualConfigurationController.java` exposes system-variable-driven configuration to the modern Medical Director review UI, including URL/redirect/cloud/registry and display controls.
- `MdReviewController` exposes `/md-review/{authId}/interqual-reviews` using the same `AuthorizationService.getAuthorizationReview()` layer as the legacy UM workspace.
- InterQual references also appear in authorization, appeals, QOC and provider-appeal code, showing criteria/review use beyond one screen.

**MCG/CareWebQI path:**

- `MedicalMgmt/.../server/service/CareWebQIService.java` constructs context/launch information, MCG partner/solution fields, CareWebQI episodes and MCG Cite AutoAuth parameters.
- `CareWebQiConfigurationController` checks both user permission and system-variable visibility for the SmartProminence React app's MD-review experience.
- `MdReviewController` exposes CareWebQI episodes using the same authorization service as the legacy UI.
- Core depends on a separate `mcg-service` artifact; `cp-medhok20-services-monorepo/mcg-service` is the adjacent shared service module, while utilities retain `carewebqi-servlet` lineage.
- MCG CCI content/assessment and copyright/custom-content handling appears in Core dynamic assessment/intervention code.

Shared outcome handling matters: Core tests around `ContinueReviewBusinessService.applyGuidelineOutcome()` show MCG/InterQual session outcomes feeding authorization rules and workflow, rather than remaining isolated external links. **[CODE]**

The returned artifacts also differ. MCG/CareWebQI lineage uses CareWebQI XML (`CwqiMessage`) plus rendered HTML; InterQual lineage uses its own XML/PDF-oriented artifacts. Core distinguishes guideline sources such as `EXTERNALGUIDELINES_MCG` and `EXTERNALGUIDELINES_IQ`. Configured approve/pend mapping is MHK workflow behavior applied to a returned criteria outcome; it should not be described as the criteria vendor independently issuing the plan's final determination. **[CODE]**

The modern bridge intentionally reuses legacy service behavior:

```text
SmartProminence React app: MD Review
  -> Core BFF configuration and review endpoints
  -> legacy AuthorizationService/CareWebQIService/domain records
  -> external InterQual or MCG/CareWebQI session
  -> returned criteria outcome/evidence
  -> Core authorization rules, review state and decision workflow
```

### 5.4 Portal landscape

“Portal” is not one application:

| Portal/surface | Audience and role | Primary code |
|---|---|---|
| Legacy CareProminence operator UI | Internal plan clinical/operational users; GWT/SmartGWT plus newer embedded/BFF surfaces | `cp-medhok-monorepo/MedicalMgmt` |
| CareProminence Provider Portal | Providers submitting/viewing authorization and related work; separate Java WAR/application family with offline assessment/service variants | `cp-provider-portal` |
| Third-party provider portal context | HealthTrio/HealthX or another client-selected provider experience reaching MHK contracts; identity, NPI/PIN/facility context matters | Client/vendor portal plus Core SAML/web-service/configuration seams |
| Core Rx/API portal documentation/surface | Pharmacy/Rx prior-auth API consumers and integrators; static/API documentation is packaged with web services | `cp-medhok-monorepo/medhok-web-services/.../rx-portal.html` and RxPA services |
| Interoperability self-service portal | Interop-oriented self-service surface; exact configuration/onboarding/support responsibilities are not deep-inspected **[INFERENCE]** | `cp-interoperability-self-service-portal` |
| Cigna-specific CP portal Lambdas | Token/NPI support for a client portal integration | `cp-aws-cigna-portal-*` repos |
| SmartProminence React app / smart UI | Modern internal/operator CareProminence UI; not the public Orchestrator offering or Provider Portal | `cp-mhk-smart-prominence` |
| Enterprise AI UI portal | Workflow/platform administration and operations; not a CP provider/member portal | `enterprise-ai-agent-platform/ui-portal` |
| MP enrollment portal | Staff/broker enrollment workflow tied to MarketProminence | `mp-enrollment-portal` |
| MP beneficiary portal | Member/beneficiary self-service UI/API/database/client overlays | `mp-beneficiary-portal-*` |
| MP premium-billing portal | Billing/payment self-service UI/API/client overlays | `mp-premium-billing-portal-*` |

`cp-provider-portal/ProviderPortal` is a Java 21 WAR with Spring MVC/Security, SAML/CAS, Hibernate, jBPM, MySQL, Core model artifacts, JAX-WS, Elasticsearch and AWS dependencies. The repository also contains offline care/assessment clients and services plus shared screen definitions. It has independently built versioned release branches; its deployed version may differ from Core. **[CODE]**

HealthTrio and HealthX appear in Core SAML/Provider Portal integration guidance as portal vendors. Provider PIN/NPI/facility/user attributes and affiliations can determine scope; those attributes also matter when launching InterQual/MCG from a portal context. Core web services expose continued/concurrent review submission and a guideline-outcome callback that can apply MCG/InterQual results to authorization rules. **[CODE]**

The Core-side Provider Portal control plane includes `PortalService`, `PortalUser`/affiliation/permission models, `ProviderPortalConfiguration*` services/models/Hibernate mappings and portal Flyway history. `cp-batch-monorepo/EventProcessing` contains `PortalEventProcessingDao` for certain portal identity/event processing. Portal work is therefore not confined to the standalone portal repository. **[CODE]**

## 6. CareProminence Core App deep dive

Canonical baseline inspected: `cp-medhok-monorepo@2ef25b7c3571166591db61fe18cb15a5d6802774`, `origin/master` on 2026-07-13. The local root checkout is on a feature branch; canonical claims in this section come from the refreshed default ref.

### 6.1 Architectural center

CareProminence Core is a configurable healthcare operations platform centered on:

- a shared client MySQL domain model;
- explicit Hibernate mappings and forward Flyway migrations;
- large Spring business/service layers;
- data-driven workflow/task/configuration;
- a legacy GWT/SmartGWT operator UI;
- a newer session-aware REST BFF inside the same WAR;
- external REST/SOAP services sharing the same model and database;
- queue/batch/client-adapter handoffs for long-running and client-specific work.

Core is a modular monolith plus adjacent sidecars, not one self-contained WAR and not a clean microservice system.

### 6.2 Repository modules

| Module | Packaging / role | Critical boundary |
|---|---|---|
| `MedicalMgmt` | `medical-mgmt` WAR: GWT/SmartGWT UI, RPC/action handlers, Spring services, BFF controllers, SPA bootstrap/proxy routes, auth/session, vendor launches | Main interactive Core runtime |
| `MedicalMgmtModels` | `model` JAR: Java entities and explicit `.hbm.xml` mappings | Shared persistence contract used by Core, APIs and many batch jobs |
| `MedicalMgmtUtilities` | `utilities` JAR: document storage, mail merge, XML/PDF/DOCX, security and infrastructure utilities | Cross-cutting document/infrastructure behavior |
| `mm-shared-services` | Business-service JAR: cross-domain rules, workflow, queue execution, correspondence, external-callout façade | Major coupling point between online and batch code |
| `mm-dynamic-loader-service` | Configurable file/data/SQL/BPM loader/action JAR | Generic ingestion and administrative extension |
| `medhok-web-services` | `medhokws` WAR: Spring/CXF REST and SOAP APIs plus portal/integration bundles | Shares Core DB/model/services; not an isolated data owner |
| `ws-doc-api` | API catalog/documentation app | Documentation, not business implementation |
| `medhok-vendor-services` | Separate vendor callback/fax WAR | Outside current parent reactor; deploy independently |
| `mhk-fhir-server` | Separate older HAPI FHIR R4 WAR with JDBC resource providers | Verify whether environment uses it, dedicated Interop, or both |
| `mm-rxclaim-service` | Legacy pharmacy claim/member/eligibility integration library | Separate from current reactor and newer client adapters |

The Java 21 parent reactor includes the first seven main modules. A Java 8 parent with similar topology remains for historical/release compatibility. The source tree contains thousands of Java files and nearly ten thousand Flyway SQL files, so changes routinely cross UI, handler/service, model/HBM, migration, workflow/config, API and report layers. **[CODE]**

### 6.3 Domain map

#### Foundational data

- **Member 360:** demographics, identifiers, contacts, eligibility, benefits, PCP, claims, clinical profile, alerts, assessments, messages, rewards and longitudinal cases. `MembersController`, `Member360Controller`, member models/HBMs and `client/member` are high-value entry points.
- **Eligibility/plan hierarchy:** company, company LOB, product line, eligibility group/plan, contract/PBP, IPA, formulary, client group and external attributes. This hierarchy drives access, SLA, workflow, correspondence and integration routing.
- **Provider 360:** identity, specialties, locations, networks, contracts, IPA, restrictions/preclusion, panels and portal/referral context. `ProvidersController`, provider models and `client/provider` are primary seams.
- **Users/roles/teams/queues:** features, packages, CRUD actions, role packages, teams/groups, queues and affiliations determine what work is visible and actionable.

#### Utilization Management

The central medical case aggregate is `Authorizations`. It connects member/eligibility, requester, providers, diagnoses/procedures, request/service type, priority, intake, status/reason/outcome, review, SLA, documents, tasks and workflow. **[CODE]**

Primary seams:

- legacy UI: `MedicalMgmt/.../client/um/auth`;
- shared/server business services and authorization service layer;
- BFF: auth, procedure, diagnosis and MD-review controllers/services;
- REST: `AuthRestServices` and `UmAuthService`;
- SOAP: medical UM authorization endpoint/implementation;
- external intake: Provider Portal, X12 278, FHIR PAS and client APIs.

UM is not a CRUD form. It handles pre-check/duplicates, clinical question sets, predetermined/full submission, provider-affiliated views, concurrent/continue review, predictive responses, guideline outcomes, workflow advancement, assignment, decision and correspondence.

#### Pharmacy

The Core pharmacy case aggregate is **DER (Drug Exception Request)**; external APIs commonly call the surface **RxPA**. `Der.hbm.xml`, `DERFormMgmtView`, `DerBusinessService`, `PharmacyController`, `RxPARestServices` and `RxPADAO` are primary paths. **[CODE]**

The domain includes member/eligibility, pharmacy, drug/NDC/GPI, providers, request/reason/type, coverage determination/redetermination, priority/SLA, status/outcome, clinical questions, notes, correspondence, PBM claims/test claims and effectuation.

#### Complaints, appeals, grievances and adjacent case domains

| Domain | Core aggregate/surface | Key behavior |
|---|---|---|
| Medical appeal | `AppealsMgmt`, appeal UI/BFF/REST/SOAP | Linked authorization, review/decision, status/SLA, documents, tasks, correspondence |
| Provider appeal/dispute | `ProviderAppealsMgmt`, Provider Dispute BFF/API | Provider/claim/auth evidence, dispute workflow, decision and notice |
| Grievance | `GrievanceMgmt`, grievance/CAG services | Intake/classification, sensitive handling, SLA, tasks and notices |
| CTM | `CtmMgmt`, CTM services/workspace | CMS complaint-tracking work linked to grievances, investigation, CMS comments/resolution and due dates |
| IRE | `IreMgmt`, IRE services/UI | Independent Review Entity submission/automation, documents and decision |
| QOC | `QualityOfCareMgmt` | Quality-of-care cases, categories, tasks, sensitive access and correspondence |
| Compliance / RCA | `Compliance`, `RcaManagement` | Action/corrective tracking, incidence/timeliness and root-cause analysis |

#### Care management and quality

Care management spans referrals, program enrollment, assessments, problems-goals-interventions (PGI), care plans, tasks, outreach, medication review and member engagement. High-value paths include `Careplan.hbm.xml`, `client/careplan`, `CareplanBusinessService`, care-management REST/SOAP services and configuration groups for `PROGRAM`, `PGIM`, `ASSESSMENTS`, `UMDEFN`, `MTM`, `MMR`, member app/care/retention and offline behavior. **[CODE]**

Other substantial domains include OMS overutilization/opioid monitoring, order tracking, referrals, site-of-care, scheduler/appointments, member management review, dashboards, issues, tasks, claims, analytics launch and administration.

### 6.4 How a case flows

```text
fax | provider portal/API | manual UI | file/batch | FHIR/X12 | callback
  -> identify member, active eligibility/LOB, requester/provider and request context
  -> enforce access/affiliation, validation, duplicates and client rules
  -> persist domain aggregate, documents, notes, contacts and audit
  -> choose BusinessProcess and create ProcessFlow
  -> choose active TaskConfiguration/TaskProcessing step
  -> assign queue/team/user and compute SLA/due date
  -> collect assessment/criteria/evidence; perform nurse/peer/MD review
  -> apply outcome, status and reason; effectuate externally when needed
  -> generate/track/deliver correspondence
  -> publish event, callback, X12/FHIR response, report/extract and audit
```

#### Workflow spine

`ProcessFlow` links an active workflow instance to authorization, DER, appeal, provider appeal, grievance, CTM, IRE, QOC, compliance, RCA, order tracking, member management, incoming image, referral, member app and other cases. It carries process instance, active task/group/user, dates and status. **[CODE]**

- `BusinessProcess` defines process context/flags.
- `TaskConfiguration` defines group, SLA, external class/expression, outcomes and launch behavior.
- `TaskProcessing` defines a concrete step, assignment/destination, correspondence trigger, rules, due dates and backend-only behavior.
- `BPMSharedService` starts/advances jBPM4 instances.

The Core jBPM job executor is configured not to auto-start. Workflow timers and long-running progression therefore frequently belong to `workflow-watcher`, queue monitor or other batch jobs rather than the web JVM. **[CODE]**

### 6.5 UI generations and BFF modernization

The original operator application is GWT/SmartGWT. Its module/portlet registry covers the breadth of the product, and requests still use GWT dispatch, SmartClient IDA calls, servlets, uploads and realtime mechanisms in the same WAR. **[CODE]**

The BFF is an incremental modernization layer inside `MedicalMgmt`:

- Spring MVC maps `/bff/*`, `/spa/*` and related routes.
- Controllers cover intake/OCR, members/providers, authorization/pharmacy, disputes/appeals, MD review, files, policy library, correspondence templates, analytics, system variables and generic forms.
- `GateKeeperAspectController` can translate REST input into an existing GWT action handler and translate the response—modern transport over legacy business behavior.
- `BffSessionInterceptor` reconstructs Core user/session context and connects React child activity to the existing `user_session` for continuous audit/productivity.
- Most BFF traffic was gated in the inspected source by `ENABLE_NEW_UM_INTAKE_EXPERIENCE`; feature/system variables can therefore cause apparently unrelated endpoint availability differences.
- SPA controllers inject/rewrite environment state for modern routes such as OCR intake, template studio, policy library and insights.

### 6.6 Persistence, Flyway, and configuration

Hibernate mappings are explicit. `applicationHibernateMapping.xml` registers `.hbm.xml` resources and creates the session factory; schema auto-generation is not the source of truth. A persistent change normally requires:

```text
Java model
  + HBM column/relationship
  + mapping registration for a new entity
  + forward Flyway migration
  + DTO/API/GWT/BFF/UI mapping
  + search/report/extract/config-export impact
  + tests
```

Changing Java/HBM without DDL can compile and fail at runtime with an unknown column. Changing DDL without mappings can leave data invisible. Search batch, client services, extracts, datamarts, reports and data-lake SQL before changing a shared table/column.

`flyway/sql` is the checked-in schema history from 2012 onward. Guardrails enforce naming and limit dangerous/multi-operation patterns, but a production-policy document is marked draft and describes a manual production execution boundary. The Core build does not itself prove Flyway was applied. **[CODE, RUNTIME-UNVERIFIED]**

Configuration is a product layer:

- environment property files/system overrides and encrypted values;
- database system variables;
- hundreds of workflow, screen, role, queue, correspondence, integration, ePA and reference tables;
- `env.file.master.txt` and `configTables.txt` export/config-push groups;
- client adapter selection and client-specific external properties.

When two environments behave differently, compare configuration/reference rows, system variables, feature permission, workflow/task definitions, adapter artifact and effective properties before changing Java.

### 6.7 API and integration surfaces

`medhok-web-services` is a shared-domain API WAR, not a microservice with its own data model. It imports Core mappings, business services, BPM and external callouts. **[CODE]**

SOAP/REST families cover authorization, documents, grievance, appeal, provider dispute, order tracking, member/referral, Rx, care management, CTM, MTM, IRE, CRM, QOC, compliance, incoming images, SCIM, duplicates and callbacks. Browser CAS/session and external SOAP/REST credentials are distinct security domains.

Core's separate `mhk-fhir-server` exposes HAPI FHIR resources and queries Core through JDBC/calls authorization REST, but it is older and outside the current reactor. Dedicated Interop may supersede or coexist with it by environment. **[CODE, RUNTIME-UNVERIFIED]**

`ExternalClientBusinessService` can invoke an in-process injected client adapter or a configured central REST client-services API. This means the same action can change topology by environment without changing the calling business method. **[CODE]**

Other direct integrations visible in Core include clinical-criteria converter, DataVisor/QuickSight launch, DBMotion, Salesforce, MediSpan, OpenSearch, Jira, telephony, payment/shipping and vendor fax paths. Presence does not establish activation.

### 6.8 Documents, correspondence, fax and template AI

- `MedicalMgmtUtilities` abstracts file and S3 storage; AWS containers mount `/medhok` through encrypted EFS, shared with web services. **[CODE]**
- Mail merge has several document-generation generations and a large tag/context dictionary across case domains. **[CODE]**
- `Documents` and `CorrespondanceTracking` link artifacts/deliveries across case types; task/status transitions can trigger correspondence definitions. **[CODE]**
- Core owns incoming-image/fax state, claim/release/reroute/split/attach/discard actions and case links; batch owns much of polling, vendor interaction and OCR orchestration. **[CODE]**
- `medhok-vendor-services` contains a vendor-neutral fax interface with configurable pollers and a Concord implementation, but its separate deployment must be verified. **[CODE, RUNTIME-UNVERIFIED]**
- Correspondence Template Studio combines the SmartProminence React app, Core BFF/persistence/dictionary, Tag AI/fuzzy suggestion, `MedhokQueue`, batch queue monitor and approved export back to existing mail-merge targets. **[CODE]**

### 6.9 Security and data access

Internal browser authentication uses CAS filters/ticket validation plus Spring session/security context. Authorization is layered:

```text
authenticated user
  -> feature + action permission
  -> package/role assignment
  -> module/queue/team assignment
  -> sensitive-case permission
  -> user affiliation/data-scope filter
```

`GateKeeperAspect` and `UserAccessControlService` enforce feature/action access. `UserAffiliations` scopes by company, LOB, eligibility group/plan, provider, IPA, product line, VIP/employee flags, external attributes and special context. A user can have module access while seeing only an affiliated subset of members/cases. **[CODE]**

External identities include SOAP WS-Security, REST integration headers, SCIM provisioning and separate PortalUser permission/affiliation models. Do not assume they share one credential lifecycle.

### 6.10 Async ownership and `MedhokQueue`

Core creates work and contains execution services, but batch usually supplies recurring runners. `MedhokQueue` is a general database handoff covering claims/auth refresh, effectuation, external submission, correspondence transfer, inactivity handling, case submissions, MTM/HRA/assessment work, real-time status, member-app inquiries and Letter Tag AI. **[CODE]**

`cp-batch-monorepo/queue-monitor` claims pending/continuous/retryable rows, marks in progress, tracks attempts, resets stuck work, dispatches by context/bean/method and writes terminal status. Other async owners include workflow/correspondence watchers, fax/OCR, ePA, outbound/X12, alerts and extracts.

When adding background work, choose deliberately among request-path execution, `MedhokQueue` context, dedicated batch module, event/Lambda flow and database-configured workflow rule.

### 6.11 Build and runtime shape

- GitHub Actions uses Corretto 21/Maven on CodeBuild, packages the Java 21 reactor with a stamped profile, uploads the Core and web-services WARs and builds separate ECR images. **[CODE]**
- Coverage uses JaCoCo but allows Maven test failures for report generation; Sonar post-merge skips tests. A completed coverage/Sonar run is not automatically a test gate. **[CODE]**
- Both primary images run Tomcat 9/JDK 21, use non-root runtime, Prometheus/JMX/OpenTelemetry/CloudWatch integration and runtime config initialization. Core includes document-rendering dependencies. **[CODE]**
- Terraform models ECS/Fargate, ALB, autoscaling, CloudWatch, Secrets Manager, encrypted EFS/backup, ECS Exec and Core caching; client/environment variables live separately. **[CODE]**
- Image publication, Terraform provisioning and environment rollout are distinct. The Core build workflow does not prove an ECS deployment or database migration. **[RUNTIME-UNVERIFIED]**

### 6.12 Core change-location guide

| Desired change | Start here | Usually inspect next |
|---|---|---|
| Legacy form/grid | `MedicalMgmt/.../client/<domain>` | RPC model, handler/service, portlet metadata, permission, HBM/Flyway |
| Smart UI backed by Core | Smart feature + `MedicalMgmt/.../server/bff` | legacy handler/service reuse, session/feature gate, DTOs |
| Domain field/relation | model Java + matching HBM | mapping registration, new Flyway, API/UI/search/report/extract |
| UM rule | authorization shared/server services | `Authorizations` mapping, BFF/API, workflow/task and criteria |
| DER/RxPA rule | `DerBusinessService`, `RxPADAO` | DER mapping/UI/BFF, ePA config, PBM adapter and batch |
| ePA state | EPA/NCPDP models + `EPAService` | schedulers/gateway, adapter, transaction logs and config |
| CAG case | matching aggregate/business service | GWT/BFF/API, workflow, SLA, correspondence, sensitive access |
| Workflow/task/outcome | BusinessProcess/TaskConfiguration/TaskProcessing/BPM services | DB config, watcher, queue, correspondence trigger, SLA calendar |
| Client/PBM callout | generic ExternalCallout use | concrete adapter, `externalcallouts.xml`, deployed profile/config |
| InterQual/MCG | criteria/episode/CareWebQI/MD-review services | permission/system variables, callback artifact and outcome mapping |
| Documents/correspondence | storage/mail-merge/correspondence services | template/config, batch watcher, delivery vendor and tracking |
| Fax/OCR | intake/OCR BFF/services | fax batch, OCR manager, Document AI mode and storage |
| Recurring work | queue context or batch module | scheduler XML, YAML, idempotency/retry and monitoring |

### 6.13 Core traps worth memorizing

1. Database configuration and reference data can change product behavior without a code diff.
2. Core and API WAR share domain/schema; an API change is often a domain change.
3. React BFF can execute legacy GWT handlers; “modern endpoint” does not imply modern isolated logic.
4. Client-specific integrations are injected; `mm-service-nop` in a generic build says nothing about a client's active adapter.
5. jBPM is embedded but background timers/watchers are mostly external.
6. `correspondance`, `MedhokQueue`, DER and other historical names are contractual.
7. Sidecar source (`mhk-fhir-server`, vendor services, Rx claim) is not deployment proof.
8. Authentication, feature permission, queue permission, sensitive-case access and affiliation can independently deny/narrow data.
9. Build, image publication, Terraform, Flyway and rollout are separate gates.
10. Payload logging can expose healthcare data; debug through approved, minimal, redacted evidence.

## 7. SmartProminence React app: modern CareProminence UI

### 7.1 What it is and is not

`cp-mhk-smart-prominence` is the modern React/TypeScript CareProminence SPA. The package name still says `document-ai-frontend`, but current scope is much larger: fax/intake queues, medical and pharmacy authorization intake, provider disputes, medical appeals, medical-director review, member/provider/diagnosis/procedure search, Document AI operations, configuration and template/reporting surfaces. **[CODE]**

It does **not** contain the CareProminence domain backend and does not replace Core App. Its normal business APIs are session-aware Core BFF endpoints. The repository name collides with the broader public SmartProminence Orchestrator brand; in technical answers, say **SmartProminence React app** when referring to this SPA. **[CODE, PRODUCT]**

```text
browser
  -> SmartProminence React app route/component
  -> RTK Query/API slice, credentials included
  -> `/bff/...`
  -> `cp-medhok-monorepo/MedicalMgmt/.../server/bff`
  -> existing Core service/domain/persistence
  -> client MySQL and downstream integrations
```

### 7.2 Technology and code organization

- React 18, TypeScript, Vite, Redux Toolkit/RTK Query, MUI, React Hook Form. **[CODE]**
- Jest, Cucumber/Playwright, Storybook and AWS RUM dependencies are present; verify which suites run in CI before treating them as release gates. **[CODE]**
- Feature roots include `src/intake`, `src/md-review`, `src/medicalDirector`, `src/document-ai`, `src/search`, `src/settings` and shared `src/core`. **[CODE]**
- `src/app/router.tsx` and `src/core/routes` are primary navigation authorities; `src/app/store.ts` shows active API slices. **[CODE]**
- API slices cover intake, users, members, providers, diagnoses, procedures, authorization, pharmacy/Rx, medical appeals, provider disputes, medical claims, MD review/history, correspondence templates, system variables and Document AI. **[CODE]**

### 7.3 Core BFF and session contract

- `src/core/api/api-config.ts` uses `VITE_API_URL` in development and `window.appState.apiUrl` in deployed bundles, and sends cookies with `credentials: 'include'`. **[CODE]**
- `.env.development` points normal API calls at `/bff/`; Vite proxies to a local `medical-mgmt` WAR and can inject a development session cookie. **[CODE]**
- Some Medical Director integrations derive the legacy application context by removing `/bff`, because external clinical-criteria launches/servlets still coexist with the new UI. **[CODE]**
- If a SmartProminence React app screen fails, investigate the React state/type/mapping and its matching Core BFF controller/service. A frontend-only diagnosis is often incomplete.

### 7.4 Build and promotion

The inspected GitHub workflow uses Node 20, runs install/lint/test/build, creates one versioned `dist` artifact, uploads it to S3 and promotes DEV by a version manifest/path. The stated pattern is “build once, promote everywhere,” but UAT/stage/prod work was still represented as TODO at the inspected commit. `.gitlab-ci.yml` remains as CI-migration history. **[CODE, RUNTIME-UNVERIFIED]**

### 7.5 Change routing

| Symptom/change | Start in the SmartProminence React app | Follow into Core |
|---|---|---|
| Intake wizard or queue | `src/intake` and its API slice | BFF intake controllers/services, incoming-image/OCR/case services |
| Medical Director review | `src/md-review`, `src/medicalDirector` | `MdReviewController`, authorization/review services, InterQual/CareWebQI config and outcome handling |
| Pharmacy/DER | pharmacy/Rx components and API slice | Rx/DER/ePA BFF/web services, PBM adapter and client config |
| Provider dispute or appeal | feature components/API types | Core provider-dispute/appeal services, workflow, correspondence |
| Document AI | `src/document-ai` | Enterprise workflow API, OCR manager/Core incoming-image state; standalone Document AI only if legacy mode is active |
| Authentication/session | app bootstrap/API config | Core session/Spring Security/SAML/BFF user profile and environment configuration |

## 8. Batch, client integrations, events, and file operations

### 8.1 There is no single batch application

`cp-batch-monorepo` is a repository of roughly seventy independently built Java applications, not one aggregate service. Most have their own `pom.xml`, Spring context, command-line entry point, configuration and runtime lifecycle. One module can be modern Java 21/Spring Boot while another retains old Spring/Hibernate/jBPM patterns. **[CODE]**

Typical execution:

```text
Skybot job XML
  -> target agent group + command set + CONFIG_KEY
  -> client/environment YAML and sensitive location config
  -> installed JAR/WAR/script + arguments
  -> MySQL/files/SFTP/API/fax/AWS/PBM/vendor
  -> status/archive/audit/output + scheduler/log/alert
```

The GitHub build workflow detects changed top-level Maven modules and builds them independently. Deployment publishes selected artifacts to internal repositories/storage; older GitLab paths remain. `cp-build-platform` also models batch as a module set and can build only changed modules. **[CODE]**

### 8.2 Schedule versus behavior contract

| Concern | Source of truth candidate | Meaning |
|---|---|---|
| When, recurrence, target agent/group, command set | `cp-product-scheduler-times` XML | Skybot/Automate schedule/control-plane definition |
| What steps/arguments/SQL/files a command runs | `cp-product-client-configs/{region}/{client}/{env}/{envid}/{command_set}` YAML | Git-tracked behavior configuration distributed to client S3 paths |
| Credentials and some physical location config | Authorized runtime S3/SSM/Secrets Manager/keystore | Deliberately not fully represented in Git |
| Java/Python algorithm | Selected batch/utility/Lambda repo and module | Executable behavior |
| Artifact/version installed | Artifactory/S3/ECR/host/ECS task definition | Actual deployed code |
| Live schedule/history | Skybot/Automate | Runtime truth |

The preferred shared runner pattern is `ia_task_runner`; many `OLD*`, jar, SQL, file-copy, correspondence and loader command sets remain in active-looking definitions. A schedule naming a JAR is not proof that the installed JAR matches source default branch. **[CODE]**

### 8.3 Batch portfolio by capability

| Capability | Representative modules | What they do |
|---|---|---|
| Fax/email/image intake | `FaxIntakeService`, `FaxIntakeServiceCVS`, `FaxMetaDataProcessor`, `emailIntakeService`, `ScannedImages-Appeals`, `barcode-generator` | Receive/watch documents, parse vendor metadata/barcodes, attach to member/case, create/reroute work |
| OCR and automated case intake | `medhok-ocr-manager` | Claims incoming-image work, calls Document AI, retrieves boundaries/results, maps/enriches, member-matches and can create cases |
| Correspondence | `batch-correspondence-watcher`, CVS variants, `Correspondance_retrigger`, suppression process, tracking extension, historical trigger | Select rules/templates, generate documents, deliver, retry/reconcile and update `correspondance_tracking` |
| Fax/delivery acknowledgement | `FaxCorrespondenceConfirmation`, `westfax-integration`, outbound file feeds | Reconcile partner delivery results and file packages |
| X12 authorization | `EdiProcessor-AmericanCoder`, `X12Generator278`, WellCare variant | Parse 278, optionally create authorization, generate response and track transaction/files |
| Pharmacy/ePA | `epa-schedulers-v2017`, CVS variant, `epa-servlet-v2017`, `epaReport`, `rx-sync`, `effectuation-process` | NCPDP lifecycle, pharmacy-case synchronization, PBM effectuation and reporting |
| Outbound/client case exchange | generic/Gateway/CVS outbound processors, Centene transaction processor | Map cases/events to client/vendor formats/APIs/files and reconcile acknowledgements |
| Workflow/tasks/alerts | `workflow-watcher`, `process-flow-mgmt`, `auto-tasking-process`, `ContextBasedAlertBatch`, `alerts-new`, queue monitoring | Advance work, create tasks, evaluate alert rules and monitor queues |
| Clinical criteria | `carewebql-service`, `mcg-batch-service` | Reconcile MCG/CareWebQI guideline artifacts and load content through shared MCG service |
| Assessments/care/quality | assessment generators/processors, care-gap and client-specific jobs | Produce/load assessments, care workflows, campaigns and downstream outputs |
| Generic data/file work | loaders, exporters, file feeds, archive manager, member merge/LDAP sync | Move/transform/reconcile shared or client-specific data |

### 8.4 OCR/Document AI flow

`cp-batch-monorepo/medhok-ocr-manager` is a modern Spring Boot/Java 21 service embedded in the batch estate. It has its own JPA entities/repositories and queue schema, calls Core REST plus external/enterprise Document AI, and uses Cognito/Secrets Manager/S3. **[CODE]**

```text
fax/upload creates incoming-image/OCR work
  -> OCR manager discovers and claims row
  -> submits document/job to Document AI workflow
  -> polls or receives completion
  -> retrieves boundaries, text, fields, artifacts
  -> crosswalk/confidence/enrichment/member match
  -> optional pending UM/Rx/provider-dispute case creation
  -> release work to CareProminence queue/workflow
```

The module documents LEGACY versus ENTERPRISE compatibility. Enterprise mode targets `document-ai-ocr-workflow`; actual mode/workflow version is client/environment configuration and must be verified. **[CODE, RUNTIME-UNVERIFIED]**

### 8.5 Client Services adapter seam

`cp-client-services-monorepo` has dozens of independent Maven modules and no single universal aggregate runtime. Generated WSDL/XSD/SOAP models are substantial, alongside REST/OAuth/FHIR adapters. `ExternalClientServicesModel` and `ExternalClientRestServices` are shared boundary projects. **[CODE]**

Core service profiles and `externalcallouts.xml` select implementations. The same UI action can therefore execute a different external call chain by client/version. When debugging:

1. Find the shared Core interface/calling method.
2. Identify the selected adapter artifact and version for the environment.
3. Inspect that module's `externalcallouts.xml`, implementation, generated contract and mappings.
4. Verify endpoint, identity/token/trust configuration without exposing values.
5. Compare external request/response, adapter mapping, Core persistence and UI interpretation.

The current GitHub workflow visibly builds only a subset of named adapters. Green CI is not evidence that every adapter in the monorepo builds or is released through the same path. **[CODE]**

### 8.6 AWS event and integration plane

The newer integration plane spans `cp-medhok20-utilities-monorepo`, `cp-medhok20-lambda-python-monorepo`, Core REST/config and per-client Terraform:

```text
Core DB change
  -> event-publishing-service polls with watermark + overlap
  -> SNS/SQS event
  -> integration rule/subscriber config
  -> Lambda/ECS enrichment calls Core REST
  -> subscriber-specific mapping and OAuth/basic/vendor call
  -> S3/Parquet/Athena audit + status callback
  -> retry/DLQ/alarm
```

Notable families include generic integration event management, external-review management, email/SMS delivery, vendor translation, auto-assignment, CDAG/reporting tools, and containerized applications inside the historically named Lambda monorepo. **[CODE]**

Watermark overlap protects against missed changes but can create duplicate candidates. Downstream idempotency must use a business/resource key; a new message UUID is not sufficient. **[CODE, INFERENCE]**

### 8.7 Safe rerun and partial-side-effect model

Before rerunning a batch/integration job, verify:

1. exact schedule, `CONFIG_KEY`, region/client/environment/envid, command set, artifact and effective config;
2. input location and whether it moved to processing/archive/error/response;
3. committed database rows and status/watermark state;
4. whether an external vendor/PBM accepted a request before a timeout;
5. partner transaction IDs for fax/email/SMS/X12/correspondence;
6. current queue visibility, receive count, DLQ and automatic redelivery;
7. idempotency keys and documented selective/dry-run/reconciliation modes.

Database transactions cannot atomically include file moves, external HTTP/SOAP calls or queue acknowledgement. “Job failed” may mean the external side effect succeeded while local status did not. **[INFERENCE]**

## 9. Interoperability: FHIR, Da Vinci, SMART, X12, and events

### 9.1 Interop is an estate, not only Core's FHIR module

Core contains `mhk-fhir-server`, FHIR wrappers, REST/SOAP services and X12 mappings. The dedicated current estate is `cp-interoperability-monorepo`, which combines a Java service, Python Lambdas, Terraform, implementation guides, test fixtures and HealthLake/SMART integration. **[CODE]**

`cp-interoperability-monorepo` baseline inspected: `main@1d420ba7ef1e7e79a99ee4cc38fb556748396c7c` (2026-07-13).

### 9.2 Main components

| Component | Responsibility |
|---|---|
| `mhk-interopt-fhirhelper` | Java 17 Spring Boot ECS service using HAPI FHIR R4/R4B, JDBC/security, HealthLake, Secrets Manager, STS, X-Ray and generated Core API models |
| `lambdas/fhir_processor` | Consumes Core change events from SQS, enriches via MHK APIs, maps resources and ingests to HealthLake |
| `lambdas/health_lake_exporter` | Exports HealthLake data to S3 for downstream delivery |
| `lambdas/smart_introspection` | Validates/authorizes SMART access for HealthLake under a strict response deadline |
| facade/SQS Lambdas | Bridge API requests and asynchronous work |
| Terraform modules | ECS/IAM/SQS/SMART/HealthLake events/target groups/load balancing/dashboards |
| DTR/implementation guides/tests | Da Vinci artifacts, questionnaires, bundles, Postman and integration validation |

### 9.3 Da Vinci prior-authorization flow

```text
FHIR client / EHR / provider application
  -> SMART/FHIR facade
  -> `Claim/$submit`
  -> Interop service converts and calls Core `preAuthSubmit`
  -> Core creates/updates UM authorization and returns ClaimResponse-shaped result
  -> Core Authorization change is published to an interested SQS queue
  -> FHIR processor enriches/converts the authorization
  -> HealthLake stores Claim/ClaimResponse and related resources
  -> `Claim/$inquire` retrieves the response path
```

ClaimResponse has two implementation entry paths: synchronous submit and asynchronous authorization-event ingestion. Both depend on shared builder logic and can diverge if changed independently. **[CODE]**

CRD discovers coverage requirements, DTR gathers required documentation/questionnaire information, and PAS carries prior-authorization submit/inquire behavior. Public MHK positioning connects this to CMS-0057-F-oriented interoperability, but activation and conformance are client/environment-specific. **[PRODUCT, CODE]**

### 9.4 Configuration and deployment caveats

- Interop CI fetches the chosen client/environment slice from `cp-configurations` and feeds Terraform. **[CODE]**
- Client-specific settings cover service/review behavior, duplicate handling, endpoints and infrastructure references. **[CODE]**
- JVM timezone must align with Core's date semantics for FHIR date-only fields; otherwise dates can shift in conversion. **[CODE]**
- README material contains older GitLab/manual-ECS history while GitHub workflows show migration toward reusable builds/Terraform. Checked-in plans do not prove current deployment. **[HISTORICAL, RUNTIME-UNVERIFIED]**
- Infrastructure such as VPC, cluster, buckets or data stores can be external to this repo; trace Terraform state and consuming config rather than expecting a self-contained stack.

### 9.5 Interoperability change routing

| Change | Primary place | Cross-check |
|---|---|---|
| FHIR-to-Core field mapping | Interop Java/Python mapper | Core OpenAPI/model, client schema/config, test bundle |
| Core authorization submit behavior | Core web services/business service | Interop Claim/ClaimResponse builder and PAS tests |
| Event-created FHIR resource | FHIR processor | Core event publisher/schema, SQS mapping, HealthLake record |
| SMART authorization | introspection Lambda/Terraform | Identity provider/client config and latency/CloudWatch evidence |
| Date shift | Interop timezone tfvars/runtime | Core server/JVM timezone and original FHIR datatype |
| X12 278 | Batch X12 processors/generators | Core authorization mapping, partner companion guide and file transport |

## 10. Data, extracts, analytics, quality, and reporting

MHK has multiple data/reporting systems because operational UI, batch extracts, regulatory reports, embedded BI, modern analytics and quality submissions have different latency, governance and presentation needs. They overlap in subject matter but are not interchangeable.

### 10.1 Data estate map

```text
CareProminence client MySQL
  |
  +--> direct Core operational queries / grids
  +--> scheduled extract/export jobs -> files/SFTP/S3/clients
  +--> datamart/QBE models -> SpagoBI/Knowage
  +--> Jasper/JRXML operational and compliance reports
  +--> DMS/replication -> Redshift ETL/materialized views -> QuickSight/DataVisor
  +--> HEDIS/quality measure processing -> IDSS/DCAP/CAHPS/QA outputs
```

### 10.2 `cp-medhok-data-extract-monorepo`

Outbound extracts and data tooling include `MedhokExporter`, generic and position-based exporters, UM XML extract, assessment datamarts, letter manifest generation, data dictionaries, SQL packs and dynamic SQL-generation tools. **[CODE]**

The common pattern is metadata/config-driven query -> streamed transformation -> CSV/XML/fixed-width/ZIP/manifest -> delivery/archive/status. Schedule, SQL/layout and transport may live in different repos/config stores. **[INFERENCE]**

### 10.3 `cp-medhok-data-import-monorepo`

Inbound ingestion includes generic loader/processor pairs plus X12 837, NDC drug, document/fax, HRA/assessment, PA-list and client-specific loaders/processors. The generic Java loader uses Spring/Hibernate/MySQL, parsing/encoding/expression and messaging support; the processor applies normalized business processing. **[CODE]**

Do not assume every module follows one stage protocol. Establish input naming, archive/error behavior, database checkpoint and rerun semantics per loader/processor.

### 10.4 Datamarts, SpagoBI, Knowage, and the BI catalog

- `cp-medhok-bi-datamart-monorepo` contains dozens of domain marts/QBE models: UM, appeals, grievances, IRE, QOC, pharmacy, member/claims/provider, assessments, productivity, assignment history, compliance, portal summaries and client/domain variants. **[CODE]**
- `cp-medhok20-spago-monorepo` and `cp-medhok20-knowage-monorepo` preserve/customize embedded BI engine generations. Both can remain relevant because client release lines differ. **[CODE]**
- `cp-canned-reports` contains a very large client/environment Jasper asset estate with both source and compiled artifacts. **[CODE]**
- `cp-bi-report-catalog` is a newer governed bundle import/export/validation path for BI metadata and assets. Its README says it is intended to become a source of truth; do not upgrade that to “already sole production authority.” **[CODE]**
- A report defect may sit in JRXML, compiled client asset, BI metadata, datamart entity/QBE mapping, engine code, database SQL or deployment—not merely “the report repo.”

### 10.5 DataVisor and the data lake

`cp-datalake-pipeline` is much broader than its narrow root README. Its tree includes ETL, `AgenticDataVisor`, DMS/Redshift utilities, materialized-view orchestration, Lambdas, Terraform/IAM/QuickSight, reports and architecture/deployment guides. **[CODE]**

The implementation-backed mental model is:

```text
client Core MySQL
  -> AWS DMS/replication and selected source tables
  -> Redshift staging/transforms/materialized views
  -> governed analytical views/models
  -> QuickSight/DataVisor dashboards and report consumers
```

DataVisor is the business analytics capability; it should not be reduced to a single directory or query agent. Operational metrics include volumes, throughput, timeliness, productivity, staffing, compliance and outcomes. **[PRODUCT, CODE]**

Important gotchas:

- Reference tables use boolean flags that drive analytical classifications; bad client configuration can change report meaning without a code error. **[CODE]**
- SQL is often Redshift-oriented while ad hoc consumers may execute MySQL. Translate types/functions intentionally (`TIMESTAMPDIFF` versus Redshift functions, etc.).
- Client timezone and date cutoffs affect daily/turnaround metrics.
- A replicated lake is not the live transaction system; freshness, late-arriving changes and MV refresh order matter.
- `DataVisor-query-agent` or `AgenticDataVisor` adds AI assistance but does not replace deterministic data governance.

### 10.6 Compliance reporting

`cp-compliance-reporting-monorepo` holds JRXML, SQL, mapping workbooks and documentation for Part C/D, CDAG, ODAG, MTM, OMS, SNP, NCQA, Medicaid, ADT, pharmacy and client-specific regulatory/operational reports. **[CODE]**

Compliance logic is the combination of regulatory specification, MHK data semantics, client mapping and effective period. A SQL optimization that preserves row counts can still change regulatory meaning. Validate source mapping, exclusion/inclusion logic, timeliness, rendered layout and representative UAT results.

Some checked-in QA documentation contains credential-like material. Never quote or propagate it; use approved secret references and rotate/sanitize exposures. **[CODE]**

### 10.7 HEDIS and population quality

`cp-hedis-monorepo` includes measure rules/models, execution, hybrid support, campaign/summary generation, IDSS/DCAP output, CAHPS files, QA and loaders/processors. Current Maven modules target Java 21 but retain long-lived Spring/Hibernate/Quartz patterns. `Measures` and `ProcessExecution` expose command-line runners. **[CODE]**

Measure work is year/version-sensitive. Resolve measure year, value sets, eligible population, source-data snapshot, client config, execution image and submission format before comparing results.

### 10.8 Reporting/change routing

| Need | Start here | Verify next |
|---|---|---|
| Client outbound extract/layout | data-extract module + metadata | scheduler/YAML, effective SQL, delivery/archive config |
| Inbound file/load | data-import loader/processor | source companion guide, checkpoint, Core schema/reference data |
| Embedded QBE/domain mart | BI datamart module | Knowage/Spago metadata and client deployment |
| Jasper operational asset | canned reports or owning app | compiled artifact and report-server promotion |
| Regulatory/CMS/NCQA report | compliance repo | spec year, mapping workbook, rendered UAT and deployment |
| DataVisor/QuickSight metric | datalake ETL/MV/view | DMS freshness, timezone/reference flags, dataset/dashboard asset |
| HEDIS result | HEDIS rules/execution | measure year, value sets, input snapshot and deployed ECS/job config |

## 11. AI, agentic, and automation platforms

### 11.1 The boundary map

| System | Users/job | Runtime center | Do not confuse with |
|---|---|---|---|
| SmartProminence Orchestrator | Standalone/cross-product governed AI orchestration offering | Public product brand; `enterprise-ai-agent-platform` is the primary inspected implementation candidate, but exact runtime mapping is **[UNKNOWN]** | SmartProminence React app or a confirmed one-repo product mapping |
| SmartProminence React app | CareProminence operators/reviewers | `cp-mhk-smart-prominence` React UI calling Core BFF and product services | Public Orchestrator offering, enterprise workflow backend or Provider Portal |
| Enterprise AI Agent Platform | Product-facing durable clinical/document/enterprise workflows | Java 21/Spring, MySQL/Flyway, SQS/S3/ECS, workflow definitions and agents | Specter engineering agents |
| Specter | Engineering/support automation over Jira, Teams, repos, logs and DB evidence | TypeScript, MySQL, SQS/S3/EFS/ECS, Claude/OpenAI/deterministic workers | CareProminence runtime |
| Storyboard AI | AI-guided QA/browser exploration and test generation | TypeScript/Node/React, Bedrock, Playwright, MySQL, WebSockets | SmartProminence React app, Orchestrator or product workflow agents |
| Tag AI | Mail-merge DOCX tag suggestion/replacement | Small web/Lambda service using Bedrock + dictionary | General Document AI |
| Standalone Document AI | Earlier/parallel document-processing application and compatibility path | Spring Boot/React, job/agent models, SQS/S3/Bedrock | Proof of current enterprise workflow deployment |
| LucidReview | AI-assisted UM review demonstrator/system | TypeScript/Fastify/React/MCP, FHIR/CQL/NLP | Core production decision authority without deployment evidence |
| `mhk-mcp-registry` | Inspected operational MCP servers for Teams, read-only MySQL, Watchdog, Jenkins, read-oriented SSH and Skybot | Independent Python/TypeScript servers | Enterprise client MCP services or `cp-mhk-mcp-catalog` |
| Enterprise-platform client MCP services | Client/tool endpoints configured with the enterprise workflow platform | `enterprise-ai-agent-platform` source and Terraform | Organization-wide operational registry |
| `cp-mhk-mcp-catalog` | CP-prefixed MCP catalog repository visible in the organization | Implementation and overlap were not deep-inspected **[UNKNOWN]** | Proof that it owns either of the other MCP layers |

### 11.2 Enterprise AI Agent Platform

`enterprise-ai-agent-platform` is a Java 21/Spring multi-module durable workflow runtime. Core concepts are Job, WorkflowDefinition/Step, WorkflowExecution/StepExecution, controller, processing agent, artifact, capability/security context and auditable LLM usage. **[CODE]**

Its architecture closely matches the public SmartProminence Orchestrator concept, so it is the primary inspected implementation candidate. Source inspection alone does not prove that it is the exclusive branded runtime or which clients/environments use it. **[CODE, PRODUCT, UNKNOWN]**

```text
authenticated submission
  -> orchestration core creates job/workflow execution
  -> controller interprets definition/DAG
  -> scoped step/capability token + execution record
  -> SQS dispatch
  -> LLM or deterministic processing agent
  -> result/artifact persisted
  -> dependency completion unlocks next steps
  -> terminal result + audit/usage metrics
```

Checked-in workflow families include Document AI versions, agentic/enterprise chat, LOE estimation, ticket discovery, SOW generation and tests. Processing agents cover PDF preprocessing/OCR, boundary detection, patient/request/sender/provider extraction, metadata, clinical criteria/evidence, document visualization/compilation/generation, MD-review summaries, chat, aggregation and general LLM processing. **[CODE]**

The Document AI architecture is migrating from a hard-coded controller and dedicated agents toward declarative workflow-engine + general LLM-processing steps, retaining specialized deterministic visualization/compilation. Multiple workflow versions therefore represent lineage/cutover, not necessarily simultaneous long-term products. **[CODE]**

Terraform layers shared infrastructure, orchestration, client endpoints/MCP, controllers, processing agents, workflow configuration, compliance/code intelligence, and an independent React `ui-portal`. Presence in Terraform does not prove environment activation. Root README module/security statements contain drift; current POM, source, migrations, architecture docs and Terraform take precedence. **[CODE]**

### 11.3 Specter engineering/support platform

`cp-autonomous-ai-agents-platform` uses an orchestrator/Harvey entry points, durable MySQL task state, S3 artifacts, repository materialization in isolated workspaces/EFS cache, and ECS/SQS worker services. **[CODE]**

Key registered workers include:

| Worker | Function |
|---|---|
| DARCI | Defect/root-cause investigation |
| SCRIBE | Code/behavior/endpoint explanation |
| PRISM | Implementation planning/refinement |
| QUALIFIER | OneShot/PFOS qualification |
| HERMES | Configuration/environment lookup |
| SENTRY / BEACON | SQL safety and model validation |
| MERIDIAN | Deterministic-first support SQL generation with read-only validation and human execution |
| BC-INTAKE / BCAT | Bulk client-upgrade intake/planning/execution |
| VERITAS | Evidence-driven RCA synthesis |
| ANVIL / NOTARY / SRLOG / FORGE / LEDGER / RIFT | YAML, release-note, log, failure, LOE and regression specialties |

Code registration and Terraform deployment are separate. Confirm enabled workers and queues per environment. **[CODE, RUNTIME-UNVERIFIED]**

**OneShot/PFOS** flow:

```text
Jira PFOS label
  -> QUALIFIER
  -> PLANNER
  -> REVIEWER
  -> IMPLEMENTER
  -> CODE_REVIEWER
  -> deterministic TESTER
  -> draft PR + Jira notifications
```

It uses circuit breakers, FIFO queues/DLQs, isolated git worktrees, durable artifacts/events and a human-visible draft PR. `mhk-project-one-shot` is a separate Python/FastAPI-style AgentX lineage; do not apply its runtime assumptions to Specter. **[CODE]**

**Spec Factory** has Compose and Louise intake lanes, durable sessions/uploads/repository grounding, and creates Jira Epics/Stories that can feed OneShot. **[CODE]**

**MERIDIAN** parses tickets/attachments, maps deterministic BECU-derived rules, uses LLM fallback, validates through read-only DB access, generates backup/mutation/audit/validation SQL and leaves execution to a DBA/human. **[CODE]**

### 11.4 Specialized AI systems

- **Storyboard AI (`cp-ai-automation-engine-platform`)**: Bedrock + Playwright browser exploration, learned selectors, GWT/SmartGWT helpers, human takeover, Cucumber/Selenium generation and MHK environment context. Marketing success/cost/readiness claims are self-reported; checked-in credential-like examples must never be propagated. **[CODE]**
- **Tag AI (`cp-ai-template-tagging-platform`)**: detects DOCX placeholders, suggests Core mail-merge tags from a large context dictionary, supports human replacement, and currently uses Bedrock despite older docs mentioning OpenAI. **[CODE]**
- **Standalone `document-ai`**: Spring Boot/React application with async jobs, configurable agents/groups, boundaries, extracted metadata, artifacts and usage/cost reporting. Treat as lineage/legacy-compatible system until client route is verified. **[CODE]**
- **MCP layers**: `mhk-mcp-registry` is the inspected operational server collection; `enterprise-ai-agent-platform` contains client MCP endpoint/service infrastructure; `cp-mhk-mcp-catalog` is a separate CP-prefixed repository that was not deep-inspected. Their ownership and overlap should not be inferred from “MCP.” **[CODE, UNKNOWN]**
- **`cp-dev-enterprise-claude-config`**: shared developer agents, skills, commands, standards and prompts; organizational enablement rather than product runtime. **[CODE]**

## 12. Build, release, configuration, deployment, and operations

### 12.1 Multi-version release reality

MHK supports multiple client and major/minor release lines simultaneously. Default branch is only one line. Older releases can require different JDKs, module sets, artifact coordinates and database migrations. Hotfix/client branches are operationally real even when they are not ideal architecture. **[CODE]**

Before a release fix, determine:

```text
repository + product version branch
  + exact client/environment
  + built artifact SHA/version
  + database/Flyway level
  + client adapter version
  + UI bundle version
  + scheduler/config version
```

### 12.2 `cp-build-platform`

Baseline inspected: `main@7771ae187ea3004959e11b4864b5f2fc06257eb1`.

- Runs scheduled planning approximately every four hours over a repo/ref catalog. **[CODE]**
- Compares per-repo/per-ref HEAD to a stored SHA marker; changed refs build in CodeBuild. **[CODE]**
- Build and publish run under separate roles: build consumes Artifactory and produces artifacts; publish writes deployment storage. AWS uses OIDC. **[CODE]**
- Catalogs Core, batch, Provider Portal, data import/extract, BI datamarts, utilities and BECU. **[CODE]**
- Dynamically discovers selected versioned branches for Provider Portal and data repos, with JDK/compute overrides for old lines. **[CODE]**
- Supports changed-module-only batch builds and a scheduled module-sync PR workflow. **[CODE]**
- Opens/updates build-failure GitHub issues and can notify Teams. **[CODE, RUNTIME-UNVERIFIED]**

This is current build control-plane evidence; it does not alone establish customer deployment. Follow published artifact into deploy automation and live environment.

### 12.3 Configuration planes

| Configuration kind | Primary source | Examples |
|---|---|---|
| Core behavior | client database system variables, reference/config tables, permissions/features | workflow visibility, due dates, criteria launch, duplicate rules, ePA and correspondence behavior |
| Newer service infrastructure | `cp-configurations` client/env tfvars + backend files | Core/web services, Interop, event publishing, data lake client, QuickSight, gateways, access control, SSO, observability, AI services |
| Batch behavior | `cp-product-client-configs` YAML | runner steps, JAR args, SQL, file operations, task/ECS/Lambda invocation |
| Schedule/target | `cp-product-scheduler-times` XML | Skybot calendar/interval/cron, agent group, command set, `CONFIG_KEY` |
| Custom deployed scripts | `cp-product-client-custom-scripts` and `infauto-*` | client/environment operational glue |
| Secrets/endpoints/trust | Secrets Manager, SSM, approved S3 config, keystores, identity systems | never infer from example property files |

`cp-configurations` is organized as `<CLIENT>/<ENV>/*.tfvars` and backend `.hcl` files. Its root README is a migration scaffold; the directory structure and consuming pipelines are stronger evidence. Terraform inputs are not proof of applied state. **[CODE]**

### 12.4 Deployment control planes

- Application repos build WAR/JAR/container/static artifacts through GitHub Actions/CodeBuild, with older `.gitlab-ci.yml` retained in many repos. **[CODE]**
- `cp-devops-jenkins-automated-deploy` is a large Groovy/Jenkins client deployment and operations plane with customer/environment properties, AWS/Ansible/Flyway/service operations and inventory/reporting. **[CODE]**
- `cp-build-platform` is the newer centralized build/publish plane for selected client-deployed repos. **[CODE]**
- Enterprise/AI/Interop systems increasingly use ECR/ECS/Terraform/GitHub OIDC and environment gates. **[CODE]**
- Skybot/Automate remains the recurring batch runtime control plane. **[CODE]**
- Build success is not deployment success; deployment success is not configuration activation; activation is not proof a user/client exercised the path.

### 12.5 Observability

`cp-medhok20-cloudwatch` baseline inspected: `main@098f495903c1c64cd84aee06552462257c6470c1`.

Its GitHub Actions/shell reports aggregate CloudWatch Logs Insights, X-Ray and operational systems into HTML digests and structured JSON artifacts. Report families include JVM/OOM, DB contention/connections, HTTP/integration, SSL/auth/SSO, Spago/Knowage, X-Ray latency, alarms, API Gateway/Lambda rates, load-balancer traffic, orphaned EC2/EBS cost, resource-shutdown candidates, Skybot failures/cadence, Opsview/OCI, GitHub workflow failures, Jira due dates, PAT expiration, workspace connections and AI usage. **[CODE, RUNTIME-UNVERIFIED]**

Resource-shutdown logic was explicitly report/evaluation-only at inspection; it did not automatically stop candidates. Structured JSON is designed for Jira/agent remediation, connecting observability to engineering automation. **[CODE]**

The broader `infauto-*` estate supplies Ansible/inventories, monitoring, ETL, file transfer, encryption/archive/email/logging, correspondence movers, database copy-downs, server scripts, scheduler log sync, CloudFormation and container factories. `-BAK` and archived names coexist with active replacements; check archive status, update history and deployment references before choosing a repo. **[CODE]**

### 12.6 Operational debugging sequence

For a failed scheduled/integration flow:

1. Identify the live Skybot job/run, target agent and failure timestamp.
2. Resolve command set, `CONFIG_KEY`, effective YAML and secret/location configuration.
3. Resolve installed artifact/container SHA and matching source branch.
4. Inspect application logs plus CloudWatch/X-Ray/scheduler wrapper logs.
5. Trace DB checkpoint/status/watermark and file/archive state.
6. Trace queue/topic/DLQ and external partner transaction/response.
7. Decide whether the failure is transport, mapping, business rule, configuration, schema, identity, vendor, deployment or observability.
8. Validate idempotency before retry; verify downstream outcome after remediation.

## 13. MarketProminence deep dive

### 13.1 Product and architectural boundary

MarketProminence is MHK's Medicare administrative estate, added through MedHOK's 2015 acquisition of MarketProminence. It is not a module of CareProminence Core App. Its center of gravity is Oracle and PL/SQL, surrounded by .NET applications/APIs, TypeScript/HTML portals, client-interface packages, schedulers, reporting and a separate deployment lineage. A plan may use both CP and MP, but shared customer identity does not imply a shared database, release, cloud, security model or owner. **[PRODUCT, CODE]**

The principal business cycle is:

```text
application or maintenance transaction
  -> eligibility/election and business validation
  -> enrollment/member record
  -> CMS submission and response processing
  -> ongoing maintenance/disenrollment
  -> premium billing and remittance
  -> CMS payment/risk/enrollment reconciliation
  -> staff, broker, beneficiary and operational reporting
```

Public product intent is documented in [Enrollment and Member Maintenance](https://mhk.com/solutions/mhk-marketprominence/enrollment-member-maintenance/), [Premium Billing](https://mhk.com/solutions/mhk-marketprominence/premium-billing/), [Financial Reconciliation](https://mhk.com/solutions/mhk-marketprominence/financial-reconciliation/), and [Web Portals](https://mhk.com/solutions/mhk-marketprominence/web-portals/). **[PRODUCT]**

### 13.2 Oracle/PLSQL center

`mp-core-database` is the foundational schema and database-image repository. The inspected tree targets Oracle 19c Enterprise and contains setup for users, roles and tablespaces; base metadata/configuration; schema objects; imports; ordered version upgrades; object validation; and Docker/ECR image publication. Treat package specifications/bodies, triggers, views, jobs, grants, synonyms and ordered upgrade scripts as application code. **[CODE]**

Key implications:

- An MP defect that appears in a web screen can originate in a PL/SQL package, view, trigger or client overlay rather than C#.
- Upgrade ordering and invalid-object checks are part of correctness. A script being present does not prove it ran against a client database.
- Oracle transaction, date, sequence, package-state and privilege semantics apply; do not paste MySQL or Redshift SQL into this estate.
- Base schema, client-specific interface/configuration and deployed data-fix layers can all participate in effective behavior.
- Database image publication through AWS ECR does not prove the full product runs in AWS; MP also has OCI Terraform and other deployment paths.

`mp-connect` is a major API/interface seam. Its tree contains database APIs, MP APIs, views, client scripts and installation-generation machinery. `mp-db-client-interfaces` owns client-facing database interface concerns, while `mp-product-client-configs` and `mp-product-scheduler-times` own MP-specific behavior/scheduling configuration. These resemble CP concepts organizationally, but their schemas and runtimes are independent. **[CODE]**

### 13.3 Applications, APIs and reporting

- `mp-web` is a broad .NET/PLSQL application estate with solution/project code, database scripts, tests, Postman assets, utilities and Jenkins history. Follow a request from controller/service into Oracle package/view calls before locating the business rule. **[CODE]**
- `mp-common-api` is a shared API surface, with `mp-common-api-cms-tester` and `mp-common-api-tester` supporting contract/system testing. A tester repo is not the runtime service. **[CODE]**
- `mp-reportmax` is a separate C# reporting application. Report SQL, Oracle objects, layout and promotion may have different owners. **[CODE]**
- `mp-utilities` and `mp-automation` hold operational/automation code; `mp-performance-testing` and `mp-sahipro` cover performance and UI-test concerns. **[CODE]**
- `mp-npp-db`, `mp-medicaid-platform`, `mp-envision-api`, and historical authentication repos represent adjacent or generational components. Verify current authority and archive state rather than inferring from a familiar name. **[CODE]**

### 13.4 Portal families

MP portals are split by business audience and technical layer:

| Family | Typical responsibility | Repository split |
|---|---|---|
| Enrollment Portal | Staff/broker application intake and enrollment workflow | `mp-enrollment-portal` plus Oracle/API dependencies |
| Beneficiary Portal | Beneficiary self-service enrollment/maintenance experience | `mp-beneficiary-portal-ui`, `-api`, `-database`, `-clients`, `-documentation`, `-launch-tester` |
| Premium Billing Portal | Billing/account/payment self-service | `mp-premium-billing-portal-ui`, `-api`, `-clients`, `-documentation` |
| Authentication/identity | Portal identity, SSO/SCIM and historical auth implementations | `mp-scim-server`; archived `mp-auth` and `mp-mhk-authenticate`; confirm current identity authority |

The UIs are generally TypeScript/HTML, APIs C#/.NET, and durable configuration/data Oracle/PLSQL. A portal change can therefore require coordinated UI, API, database package/migration, client overlay, identity configuration and deployment work. **[CODE]**

### 13.5 Delivery and operations

The MP delivery plane includes `mp-devops-jenkins`, `mp-jenkins-config`, `mp-deployment-scripts`, `mp-devops-terraform`, `mp-devops-tf-oci`, and `mp-tf-dev`. Historical SVN and network-share references remain in some documentation. They are useful lineage evidence, not automatic present-day authority. **[CODE]**

For an MP deployment or incident, resolve:

```text
client + MP product/version
  + Oracle schema and applied upgrade level
  + installed .NET/API/UI build
  + client interface/config package
  + scheduled job definition
  + identity endpoint/configuration
  + hosting target and deployment pipeline
```

Do not conclude “one cloud” from a single repo: Oracle images can publish to ECR while infrastructure code also targets OCI. Inspect the component's active pipeline and live resources. **[CODE, RUNTIME-UNVERIFIED]**

### 13.6 MP change-location guide

| Change or symptom | Start here | Then inspect |
|---|---|---|
| Enrollment/member business rule or Oracle error | `mp-core-database`, then `mp-web` | applied version, package body, client overlay, input transaction |
| Database/API interface contract | `mp-connect`, `mp-db-client-interfaces` | consumer, generated installation, grants/synonyms, client script |
| Common service endpoint | `mp-common-api` | Oracle call, auth, API tester, deployed configuration |
| Beneficiary portal behavior | corresponding `mp-beneficiary-portal-*` layer | API/database/client overlay/identity |
| Premium billing portal behavior | corresponding `mp-premium-billing-portal-*` layer | billing package/data, payment integration, identity |
| Enrollment portal behavior | `mp-enrollment-portal` | `mp-web`, Oracle packages, CMS exchange/config |
| Report output | `mp-reportmax` | source SQL/view/package, template, client config, promotion |
| Schedule/arguments | `mp-product-scheduler-times` / `mp-product-client-configs` | selected executable and deployment scripts |
| MP deployment | MP Jenkins/deployment/Terraform repo matching the target | installed artifact, Oracle upgrade log, live hosting state |

## 14. End-to-end reference flows

These are retrieval maps, not claims that every client uses every step. At each arrow, capture a stable correlation handle: member/case/auth/DER ID, incoming-image/document ID, vendor transaction ID, event ID, file name/control number, job run ID, correspondence ID or portal request ID.

### 14.1 Internal medical authorization and clinical review

```text
legacy GWT or SmartProminence React app intake
  -> Core service/BFF validates member, provider, service and LOB
  -> authorization + review/request records in client MySQL
  -> workflow/task assignment and turnaround-time calculation
  -> nurse/medical-director review
  -> InterQual or MCG launch when configured
  -> returned criteria evidence/outcome stored in Core
  -> determination and authorization-line status
  -> correspondence/effectuation/events
  -> compliance report, extract and analytics consumers
```

Start in `cp-mhk-smart-prominence/src/<feature>` for modern UI state; follow `/bff` into `MedicalMgmt/.../server/bff`; then shared service/model/Hibernate mapping/Flyway. Criteria vendors support the plan's review; Core workflow applies configured outcomes and records the actual determination. **[CODE]**

### 14.2 Provider Portal prior authorization

```text
provider identity/SAML/CAS + affiliation/NPI/facility scope
  -> `cp-provider-portal` submission or continued/concurrent review
  -> Core web-service/domain validation
  -> medical authorization/review records
  -> optional MCG/InterQual launch/callback
  -> status/document/correspondence exposed back to provider
```

Debug identity/scope separately from business validation. HealthTrio or HealthX may be the third-party portal/context carrier for a client; CP Provider Portal is a separate MHK application. A portal “success” page is not proof that Core created the intended authorization—verify the returned ID and Core state. **[CODE]**

### 14.3 Pharmacy PBM/NCPDP ePA

```text
prescriber/portal/network transaction
  -> NCPDP gateway or ePA scheduler
  -> adapter/network acknowledgement
  -> member/drug/benefit/case-match validation
  -> Core DER + NCPDP transaction/history
  -> CD/RD/appeal workflow and clinical review
  -> decision
  -> PBM override/effectuation/test-claim path
  -> provider/member communication
  -> transaction/compliance reporting
```

Do not conflate three states: transport acknowledgement, MHK clinical/workflow decision, and downstream PBM effectuation. Persist and reconcile each. Use `EPAService`, NCPDP transaction models, selected ePA batch/gateway, selected PBM adapter and the client's effective configuration. **[CODE]**

### 14.4 Medical X12 278

```text
trading partner 278 request/file
  -> transport/file receipt and control-number validation
  -> X12 parser/generator or client adapter
  -> Core medical authorization
  -> review/determination
  -> 278 response generation
  -> acknowledgement/archive/error handling
```

This is medical services review, not pharmacy NCPDP ePA. Search `X12Generator278*`, data import/utilities, client configuration, scheduler definition and Core authorization services. Preserve interchange/group/transaction control numbers and distinguish TA1/999 transport/syntax acknowledgement from the business response. **[CODE]**

### 14.5 FHIR/Da Vinci PAS

```text
FHIR client `Claim/$submit`
  -> Interop authentication/validation/conversion
  -> Core `preAuthSubmit`
  -> Core authorization
  -> initial ClaimResponse
  -> later Core Authorization event on SQS
  -> FHIR processor enrichment/conversion
  -> HealthLake Claim/ClaimResponse
  -> client `Claim/$inquire`
```

CRD discovers requirements, DTR collects rule-driven documentation, and PAS exchanges the authorization request/response. These are related protocols, not synonyms. Timezone/date-only handling is a cross-system contract; client-specific duplicate and bed/review rules can alter behavior. **[CODE]**

### 14.6 Fax/OCR/Document AI intake

```text
fax/email/upload
  -> incoming-image record and source metadata
  -> OCR manager claims work
  -> LEGACY or ENTERPRISE Document AI endpoint
  -> preprocess/OCR/classify/extract/boundaries/artifacts
  -> member/provider/crosswalk enrichment + confidence
  -> human review when needed
  -> create/attach UM, Rx or provider-dispute case
  -> release/status/audit and downstream workflow
```

The current enterprise seam spans Core, `cp-batch-monorepo/medhok-ocr-manager`, `enterprise-ai-agent-platform`, and the SmartProminence React app. Standalone `document-ai` remains relevant to compatibility/lineage. A document job can finish successfully while case creation fails; inspect both workflow status and Core side effects. Retry only after establishing claim/lease and case-creation idempotency. **[CODE]**

### 14.7 Correspondence

```text
case decision or operational trigger
  -> select template/version/language/delivery rules
  -> resolve mail-merge tags and attachments
  -> render document
  -> suppress/bundle/route as configured
  -> print/fax/email/SMS/vendor delivery
  -> load acknowledgement/status
  -> retain artifact, audit, failure and retrigger state
```

Correspondence spans Core model/business services, JRXML/DOCX templates, batch generators/watchers, InfAuto movers, vendor/fax services and status loaders. A “letter bug” can be source data, tag context, template logic, render engine, file movement, vendor rejection or status reconciliation. Preserve historical `correspondance_*` database spellings. **[CODE]**

### 14.8 Client file and scheduled batch

```text
Skybot XML: time + target agent + command set + CONFIG_KEY
  -> InfAuto runner resolves effective client YAML
  -> file/S3/SFTP/NFS/SQL/JAR/task/Lambda operation
  -> selected batch/import/extract/utility artifact
  -> Core DB/API or external partner
  -> output/archive/error/checkpoint
  -> monitoring and downstream schedule
```

Timing belongs in `cp-product-scheduler-times`; behavior/arguments/file steps in `cp-product-client-configs`; algorithm in the selected application module; wrapper/file plumbing in `infauto-*`; deployment version elsewhere. Never infer one from another. **[CODE]**

### 14.9 DataVisor and reporting

```text
Core transactional MySQL
  -> DMS/ETL selection and replication
  -> Redshift transformations/materialized views
  -> QuickSight DataVisor datasets/dashboards

Core transactional MySQL
  -> domain datamart/QBE model
  -> SpagoBI/Knowage report metadata and JRXML/Jasper

Core data
  -> extract/compliance/HEDIS job
  -> client/regulatory file or report
```

These paths answer overlapping questions but have different latency, dialect, governance and promotion. `AgenticDataVisor` and `DataVisor-query-agent` are engineering/query aids visible in data repos; source does not establish them as the customer-facing DataVisor runtime. **[CODE]**

### 14.10 CP release/configuration activation

```text
source commit on exact release ref
  -> repo workflow / cp-build-platform planning
  -> build in CodeBuild or component pipeline
  -> artifact publication
  -> client/environment deploy automation
  -> Flyway/schema and service/static deployment
  -> cp-configurations IaC inputs and applied infrastructure state
  -> DB system variables/reference data and adapter wiring
  -> client YAML behavior + Skybot XML schedule/target where applicable
  -> client custom scripts / InfAuto wrapper and file plumbing
  -> CloudWatch/X-Ray/Opsview/Skybot monitoring
  -> smoke/runtime evidence
```

“Merged,” “built,” “published,” “deployed,” “configured,” and “exercised” are distinct states. A release question is incomplete without all relevant coordinates. **[CODE, RUNTIME-UNVERIFIED]**

### 14.11 MarketProminence enrollment and billing

```text
enrollment portal/file/application
  -> .NET/API validation
  -> Oracle package and member/enrollment state
  -> CMS submission/response
  -> maintenance/disenrollment
  -> premium/account calculation
  -> billing portal/remittance/payment
  -> CMS financial reconciliation and reporting
```

Trace portal request ID, member/enrollment key, CMS transaction/batch, Oracle package/version and billing account separately. A CMS transport acknowledgement, accepted enrollment and reconciled payment are different milestones. **[PRODUCT, CODE]**

## 15. Change routing, incident triage, and source-navigation heuristics

### 15.1 Where a change usually belongs

| Desired change | Primary code/config owner | Common coordinated impact |
|---|---|---|
| Shared CP business rule, workflow, model, GWT screen, BFF, REST/SOAP, Flyway | `cp-medhok-monorepo` | Smart UI, batch, adapters, reports/extracts, Provider Portal |
| Modern operator UI | `cp-mhk-smart-prominence` | Core BFF/session/permissions; enterprise workflow contract |
| Provider-facing CP behavior | `cp-provider-portal` | Core API/model, identity/affiliation, criteria vendor |
| PBM/payer/vendor-specific synchronous behavior | `cp-client-services-monorepo` module | Core common contract/profile, credentials, response mapping |
| Scheduled algorithm/watcher/feed/ePA/correspondence/OCR | selected `cp-batch-monorepo` module | scheduler XML, YAML, Core schema/API, InfAuto wrapper |
| Generic/client import | `cp-medhok-data-import-monorepo` | source layout, Core schema, scheduling/config |
| Utility/nonstandard integration | selected `cp-medhok20-utilities-monorepo` module | deployment, scheduler/config, partner contract |
| Job time/target/calendar | `cp-product-scheduler-times` | live Skybot deployment |
| Job arguments/steps/file locations | `cp-product-client-configs` | InfAuto command-set implementation and secret location config |
| Client/environment IaC input | `cp-configurations` | consuming Terraform, live state/task definition |
| FHIR/Da Vinci/HealthLake behavior | `cp-interoperability-monorepo` | Core API/events, client config, SMART/auth, HealthLake |
| Product document/clinical agent workflow | `enterprise-ai-agent-platform` | OCR manager/Core/Smart UI contracts and Terraform |
| Engineering/support agent workflow | `cp-autonomous-ai-agents-platform` | GitHub/Jira/Teams/AWS/MCP permissions |
| Regulatory report | `cp-compliance-reporting-monorepo` | specification/mapping, Core data semantics, client artifact promotion |
| Jasper client report asset | `cp-canned-reports` or governed BI catalog path | Knowage/Spago metadata, compiled asset, promotion |
| QBE/domain datamart | `cp-medhok-bi-datamart-monorepo` | Core schema, BI engine and metadata |
| Extract/data dictionary | `cp-medhok-data-extract-monorepo` | Core schema, client mapping, scheduler |
| DataVisor/Redshift/QuickSight model | `cp-datalake-pipeline` / `cp-quicksightassets` | DMS selection, reference flags, timezone, dashboard promotion |
| HEDIS measure/submission | `cp-hedis-monorepo` | member/claim source quality, scheduling, NCQA spec |
| Build selection/publication | `cp-build-platform` or component workflow | artifact store, release ref, deploy automation |
| Client deployment/Flyway/service operation | `cp-devops-jenkins-automated-deploy` and target pipeline | artifact, properties, Ansible, DB, service runtime |
| Generic file/archive/encryption/email/runner wrapper | relevant active `infauto-*` repo | client YAML, host inventory, schedule, secret/config |
| MP Oracle/business rule | `mp-core-database` | `mp-web`, `mp-connect`, client interface, applied upgrade |
| MP UI/API/portal | corresponding `mp-*` family | Oracle package, auth, client overlay, deployment |

### 15.2 Symptom-to-evidence matrix

| Symptom | First evidence to collect | Frequent hidden cause |
|---|---|---|
| UI field/button absent | user permissions, system variables/reference data, effective UI/Core versions, BFF response | feature disabled, version skew, LOB/client configuration |
| UI saved but data appears wrong | network request/response, Core service path, DB row/audit, mapping | display cache, client adapter mapping, transaction rollback |
| Provider cannot see member/auth | identity assertion, user/provider/NPI/facility affiliations and LOB scope | affiliation restriction rather than missing data |
| PBM call failed | adapter module/version, request correlation, auth/transport status, sanitized vendor response | wrong client adapter/profile, token/cert, partner outage, mapping |
| ePA “stuck” | NCPDP transaction/history, scheduler run, DER state, acknowledgement type, outbound response | transport ack mistaken for decision, case-match exception, missing effectuation |
| InterQual/MCG launch unavailable | permission, system variables, vendor URL/license/config, auth/LOB/review state | visibility config or missing portal context, not vendor outage |
| Criteria returned but workflow did not move | returned vendor artifact/outcome, guideline source, Core mapping/config and task state | MHK outcome mapping/pend rule, stale review record |
| Batch job failed | live run ID/log, exact config key/YAML, installed JAR SHA, input/checkpoint/file state | wrapper/config/file permission rather than Java code |
| Batch rerun duplicated data | checkpoint/idempotency key, partial DB/file/external effects | retry began after side effect but before success marker |
| Fax/OCR job complete, no case | document workflow job + OCR-manager record + Core create-case response | extraction succeeded but enrichment/match/case creation failed |
| Letter missing/wrong | correspondence ID, source case data, template version, render and delivery status | tag context/template/promotion/vendor status mismatch |
| FHIR submit succeeded, inquiry stale | Claim/ClaimResponse IDs, Core auth ID, event ID, queue/DLQ, HealthLake record | async event or conversion failed after synchronous submit |
| Report differs from UI | report engine/path, query dialect, data refresh time, effective client mappings | replicated lag, reference flags, different business-date logic |
| Unknown DB column at runtime | deployed code/model version versus applied Flyway/Oracle upgrade | code/schema drift, wrong release database |
| “Deployment succeeded,” behavior unchanged | artifact digest, target env, service/task/static asset, DB/config activation | pipeline deployed another ref/target; cache or feature flag |
| MP invalid object/API error | Oracle upgrade log, object validity, grants/synonyms, package body/version | partial upgrade or client overlay invalidation |

### 15.3 Repository investigation method

1. Start with the repository's canonical `origin/main` or `origin/master`, then identify the client release branch. Do not use a dirty ticket checkout as organization-wide truth.
2. Search for the user-visible noun, database table/column, endpoint, system-variable key, exception text and vendor transaction—not only the ticket wording.
3. In monorepos, identify the independently built module before running builds or changing shared parents.
4. Follow contracts in both directions: caller and callee, producer and consumer, Hibernate mapping and Flyway, scheduler XML and YAML, event publisher and subscriber, template and data provider.
5. Read build manifests and workflows to learn Java/Node/.NET/Python version and artifact shape. Retained `.gitlab-ci.yml` or Jenkins files may represent history or coexistence; verify the active path.
6. For DB changes, search Core/batch/adapters/extracts/reports/datalake/BI before modifying a shared column or semantic flag.
7. For client-specific behavior, locate the common interface first, then the active client implementation and configured artifact. A similarly named adapter generation is not interchangeable.
8. For runtime claims, corroborate source with deployed artifact, effective config, DB migration level, queue/scheduler state and timestamped logs.

### 15.4 Definition of done by change type

- **Shared application change:** targeted tests pass; contract and permission behavior verified; schema migration is additive/ordered/guarded; consumers searched; exact release line builds.
- **Client adapter change:** sanitized contract fixture or mock covers mapping; auth/error/timeout semantics preserved; selected deployment profile verified; no unrelated clients changed.
- **Batch change:** module-level build/tests pass; restart/idempotency and partial side effects documented; YAML/XML compatibility checked; input/output/archive/checkpoint behavior verified.
- **Reporting/data change:** source-of-truth path identified; SQL dialect confirmed; regulatory/business mapping reviewed; refresh/promotion route tested; totals reconciled to a trusted slice.
- **Portal/UI change:** backend contract and identity/permission scope tested; loading/error/empty states covered; release skew considered; accessibility and browser flow checked.
- **AI workflow change:** deterministic validations remain authoritative; PHI/PII boundary and audit trail preserved; model/config version pinned; retry/timeout/cost and human-review path tested.
- **Deployment/config change:** plan/diff reviewed; secret values stay outside Git; target client/env and rollback identified; applied state and smoke evidence captured.

## 16. Repository atlas

### 16.1 How to interpret the catalog

The authenticated `mhk-repos` organization snapshot on **2026-07-13** exposed **221 repositories**: 205 active and 16 archived; 92 classified as CareProminence, 43 MarketProminence, 77 infrastructure automation, 5 AI/platform, and 4 other/shared. These counts are a dated visibility snapshot, not a permanent inventory or deployment count. Prefix and description are routing clues; source, archive state, consumers and runtime references establish authority. **[CODE]**

The high-value repository map is:

| Repository | What it owns or strongly signals |
|---|---|
| `cp-medhok-monorepo` | CareProminence Core: GWT/SmartGWT, BFF, business services, model, REST/SOAP, FHIR, Flyway |
| `cp-mhk-smart-prominence` | Modern React/Vite CareProminence operator UI |
| `cp-provider-portal` | Separate provider-facing CP application and offline variants |
| `cp-batch-monorepo` | Independently built scheduled/event/file/OCR/ePA/correspondence jobs |
| `cp-client-services-monorepo` | Client/PBM/vendor adapters behind shared service boundaries |
| `cp-medhok-data-import-monorepo` | Generic and client/format-specific inbound data loaders/processors |
| `cp-medhok20-utilities-monorepo` | Shared/nonstandard Java utilities, gateways and client jobs |
| `cp-medhok20-services-monorepo` | Shared older/newer service modules including MCG, AWS, messaging, fax and language/text integrations |
| `cp-product-scheduler-times` | Skybot job timing, target and command-set XML |
| `cp-product-client-configs` | Effective job behavior YAML selected by `CONFIG_KEY` |
| `cp-product-client-custom-scripts` | Client/environment deployed operational scripts |
| `cp-configurations` | Client/environment Terraform input catalog for newer CP services |
| `cp-build-platform` | Centralized catalog-driven build and artifact publication for selected client-deployed repos |
| `cp-devops-jenkins-automated-deploy` | Client/environment deploy, Flyway/service and operational automation |
| `cp-interoperability-monorepo` | FHIR R4/R4B, Da Vinci PAS, SMART, HealthLake and event conversion |
| `cp-medhok-data-extract-monorepo` | Outbound extracts, data dictionaries and SQL/export tooling |
| `cp-medhok-bi-datamart-monorepo` | Domain QBE/datamart models for BI |
| `cp-datalake-pipeline` | DMS/ETL/Redshift/materialized views/QuickSight DataVisor estate |
| `cp-bi-report-catalog` | Governed BI bundle import/export and metadata tooling |
| `cp-canned-reports` | Client/environment Jasper assets |
| `cp-compliance-reporting-monorepo` | Regulatory JRXML, SQL, mappings and report artifacts |
| `cp-hedis-monorepo` | HEDIS measures, hybrid operations and IDSS/DCAP/CAHPS outputs |
| `cp-medhok20-knowage-monorepo` / `cp-medhok20-spago-monorepo` | BI engine generations/customizations |
| `enterprise-ai-agent-platform` | Durable product-facing healthcare/document LLM workflows and processing agents |
| `cp-autonomous-ai-agents-platform` | Specter engineering/support agents, Harvey, OneShot/PFOS, Spec Factory, MERIDIAN |
| `document-ai` | Standalone/legacy-compatible medical-document workflow lineage |
| `cp-ai-automation-engine-platform` | Storyboard AI browser/test automation |
| `cp-ai-template-tagging-platform` | Tag AI DOCX/mail-merge tag assistance |
| `mhk-mcp-registry` | Bounded operational MCP servers |
| `mp-core-database` | MarketProminence Oracle/PLSQL schema, upgrades and database images |
| `mp-web` | Broad MarketProminence .NET/PLSQL application estate |
| `mp-connect` | MP database/API/interface layer and client install generation |
| `mp-common-api` | MP common API surface |
| `mp-enrollment-portal` | MP enrollment portal |
| `mp-beneficiary-portal-*` | MP beneficiary UI/API/database/client/documentation/test family |
| `mp-premium-billing-portal-*` | MP premium billing UI/API/client/documentation family |
| `mp-reportmax` | MP C# reporting application |

### 16.2 CareProminence organization family

All names below were visible in the dated organization snapshot. Grouping is functional and does not assert team ownership or deployment.

- **Core, UI and product surfaces:** `cp-medhok-monorepo`, `cp-mhk-smart-prominence`, `cp-provider-portal`, `cp-medhok20-medhok-spa`, `cp-rn-cmoffline`, `cp-react-native-sandbox`, `cp-enterprise-ux-designs`, `cp-lucidreview`, `cp-medhok20-acg`, `cp-medhok20-cerner-fhir`.
- **Batch, adapters, services and inbound/outbound edges:** `cp-batch-monorepo`, `cp-client-services-monorepo`, `cp-medhok-data-import-monorepo`, `cp-medhok20-utilities-monorepo`, `cp-medhok20-services-monorepo`, `cp-medhok20-lambda-monorepo`, `cp-medhok20-lambda-python-monorepo`, `cp-medhok-opensearch`, `cp-aws-vendor-services`, `cp-aws-external-aspose-microservice`, `cp-aws-cigna-portal-chcp-token-lambda`, `cp-aws-cigna-portal-npi-list-service-lambda`, `cp-aws-integration-dashboard-lambda`, `cp-aws-paralleldots-emotion_py3_lambda`, `cp-aws-paralleldots-sentiment_py3_lambda`.
- **Interoperability family:** `cp-interoperability-monorepo`, `cp-interoperability-crd-request-generator`, `cp-interoperability-deployment-orchestrator`, `cp-interoperability-dms-tester`, `cp-interoperability-gitlab-runners`, `cp-interoperability-promote-amazon-quicksight-through-cicd`, `cp-interoperability-self-service-portal`, `cp-interoperability-sushi-ig-documentation`, `cp-interoperability-terraform-provider-quicksight`, `cp-interoperability-tf-ecr`.
- **Data, BI, reporting, correspondence and quality:** `cp-datalake-pipeline`, `cp-medhok-data-extract-monorepo`, `cp-medhok-bi-datamart-monorepo`, `cp-bi-report-catalog`, `cp-canned-reports`, `cp-compliance-core`, `cp-compliance-reporting-monorepo`, `cp-hedis-monorepo`, `cp-quicksightassets`, `cp-medhok20-knowage-monorepo`, `cp-medhok20-spago-monorepo`, `cp-jrxml-letter-templates`, `cp-letter-templates-jrxmls`, `cp-ROI_and_CMS_analysis_for_plans`.
- **Build, configuration, identity, infrastructure and operations:** `cp-build-platform`, `cp-configurations`, `cp-product-client-configs`, `cp-product-client-custom-scripts`, `cp-product-scheduler-times`, `cp-cloud-platform-engineering`, `cp-medhok20-cloudwatch`, `cp-medhok20-becu-utility`, `cp-medhok20-config-compare-monorepo`, `cp-medhok20-idp-mfa`, `cp-medhok20-medhok-nfsmount`, `cp-medhok20-sandbox-perf-iac`, `cp-medhok20-scripts`, `cp-medhok20-sonarqube`, `cp-medhok20-sql-performance-analyzer`, `cp-devops-builder-helper`, `cp-devops-cas`, `cp-devops-deploy-dev-scripts`, `cp-devops-github-migration`, `cp-devops-gitlab-templates`, `cp-devops-jenkins-automated-deploy`, `cp-devops-jenkins-automated-sql`, `cp-devops-newapp1`, `cp-devops-private-ca`, `cp-devops-prompts`, `cp-devops-repo-factory`, `cp-devops-shib-idp`, `cp-github-workflow-templates`.
- **AI, engineering enablement, QA and experiments:** `cp-ai-automation-engine-platform`, `cp-ai-template-tagging-platform`, `cp-autonomous-ai-agents-platform`, `cp-mhk-mcp-catalog`, `cp-medhok-defect-definition`, `cp-medhok20-architecture-poc`, `cp-medhok20-internal-ai-tools-monorepo`, `cp-medhok20-knowledge-base-tools`, `cp-medhok20-poc-monorepo`, `cp-medhok20-prod-support-genie`, `cp-dev-enterprise-claude-config`, `cp-dev-agile-practices`, `cp-dev-qa-test-cases`, `cp-qa-automatedregressionsuite`, `cp-qa-monorepo`.

Names such as `medhok20`, `spa`, `poc`, `core`, `cloud`, or `AI` do not establish current production authority. Inspect consumers and delivery references.

### 16.3 MarketProminence organization family

- **Core and application:** `mp-core-database`, `mp-web`, `mp-connect`, `mp-common-api`, `mp-common-api-cms-tester`, `mp-common-api-tester`, `mp-db-client-interfaces`, `mp-npp-db`, `mp-medicaid-platform`, `mp-reportmax`.
- **Beneficiary portal:** `mp-beneficiary-portal-ui`, `mp-beneficiary-portal-api`, `mp-beneficiary-portal-database`, `mp-beneficiary-portal-clients`, `mp-beneficiary-portal-documentation`, `mp-beneficiary-portal-launch-tester`.
- **Enrollment and billing portals:** `mp-enrollment-portal`, `mp-premium-billing-portal-ui`, `mp-premium-billing-portal-api`, `mp-premium-billing-portal-clients`, `mp-premium-billing-portal-documentation`.
- **Configuration, deployment, infrastructure and automation:** `mp-product-client-configs`, `mp-product-scheduler-times`, `mp-deployment-scripts`, `mp-devops-jenkins`, `mp-jenkins-config`, `mp-devops-terraform`, `mp-devops-tf-oci`, `mp-tf-dev`, `mp-automation`, `mp-utilities`, `mp-performance-testing`, `mp-sahipro`, `mp-scim-server`.
- **AI/developer/experimental:** `mp-ai-resources`, `mp-claude-npp`, `mp-codex-marketplace`, `mp-plsql-agentic-dev`, `mp-clients-poc`.
- **Archived in the snapshot:** `mp-auth`, `mp-envision-api`, `mp-mhk-authenticate`, `mp-reed-utility`. Archived code can explain history or dependencies, but should not be selected for new work without proof.

### 16.4 Infrastructure Automation family

The `infauto-*` estate is operational glue used around product applications. It includes reusable runners, file movement, host configuration, monitoring and one-off/client automation. Route by the effective command set and deployment reference, not merely the closest repository name.

- **Runners and workflow:** `infauto-task-runner`, `infauto-jar-runner`, `infauto-sql-runner`, `infauto-workflow-modules`, `infauto-pipeline-scheduling`, `infauto-ai-batch-config-factory`, `infauto-scheduler-ai-agents-platform`.
- **File, archive, encryption and delivery:** `infauto-filecopier`, `infauto-filecopier-core`, `infauto-filecopier-poctest`, `infauto-archive`, `infauto-recursive_archiver`, `infauto-crypt`, `infauto-emailer`, `infauto-correspondence_exporter`, `infauto-correspondence_loader`, `infauto-medispan`.
- **ETL and scheduler telemetry:** `infauto-central_etl_reporting`, `infauto-etl-central`, `infauto-etl-opsview`, `infauto-etl-scheduler`, `infauto-log-sync`, `infauto-scheduler-logs-aws-sync`.
- **Monitoring, logging and metrics:** `infauto-alerter`, `infauto-cloud-monitoring`, `infauto-logging`, `infauto-metrics`, `infauto-monitor`.
- **Configuration, secrets and shared Python:** `infauto_aws_secrets_management`, `infauto-central_py_package_publisher`, `infauto-python-virtualenv`, `infauto-utils`, `infauto-utils-supplement`, `infauto-variables`.
- **Ansible, infrastructure and hosts:** `infauto-ansible`, `infauto-ansible4`, `infauto-ansible4-etl`, `infauto-ansible4-inventories`, `infauto-ansible4-windows`, `infauto-infrastructure-repository`, `infauto-datacenter`, `infauto-dba-copydown`, `infauto-container-factory`, `infauto-se-ansible-host-group-vars`, `infauto-se-ansible-inventories`, `infauto-se-ansible-misc`, `infauto-se-ansible-playbooks`, `infauto-se-ansible-roles`, `infauto-se-cfn-misc`, `infauto-se-monorepo`, `infauto-se-ocir-hello-world-ol8`, `infauto-se-org-docs`, `infauto-se-terraform`, `infauto-se-terraform-modules`.
- **Miscellaneous/one-off/history:** `infauto-atlassian-core`, `infauto-legacy`, `infauto-oneoff`, `infauto-testdata`, `itops-oneoff`.
- **Backup-named but not archived in the snapshot:** `infauto-archive-BAK`, `infauto-correspondence_loader-BAK`, `infauto-datacenter-BAK`, `infauto-emailer-BAK`, `infauto-filecopier-core-BAK`, `infauto-jar-runner-BAK`. Backup naming still makes authority doubtful; verify deployment references.
- **Archived in the snapshot:** `infauto-alerter-BACKUP`, `infauto-crypt-BAK`, `infauto-etl-echeduler.BAK`, `infauto-filecopier-BAK`, `infauto-issues`, `infauto-logging-BAK`, `infauto-metrics-BAK`, `infauto-oneoff-backup`, `infauto-sql-runner-BAK`, `infauto-task-runner-BAK`, `infauto-utils-BAK`, `infauto-variables-BAK`. Do not route new work here without evidence that a supported release still consumes them.

### 16.5 AI/platform and other/shared family

- Organization-level AI/platform: `document-ai`, `enterprise-ai-agent-platform`, `mhk-leadership-agents`, `mhk-mcp-registry`, `mhk-project-one-shot`.
- Other/shared: `internal-dev-tools`, `medical-classification-service`, `medhok-ocr-manager`, `github-backup`.

The standalone `medhok-ocr-manager` repository is older/separate lineage; the actively analyzed OCR manager is also a module under `cp-batch-monorepo`. Resolve origin, commit and consuming deployment before editing either.

### 16.6 Local workspace and Git discipline

At the snapshot, the immediate workspace had 38 Git roots but only 28 unique origins: 27 MHK origins plus the external `perplexityai/bumblebee` checkout. Ticket/release worktrees and duplicate clones are not additional systems. Important examples:

- multiple `cp-medhok-monorepo-*` directories are linked ticket/release worktrees;
- `cp-mhk-smart-prominence-pipeline-fix` is a linked SmartProminence worktree;
- `cp-medhok-data-extract-monorepo-pr48-3.20` is a branch-specific duplicate clone;
- local `Specter` is a stale/dirty clone of `cp-autonomous-ai-agents-platform`, not a second repository;
- `.worktrees/` and `cpdev-*-work` contain retrofit/forensic workspaces;
- `smart-prominence-insights-local`, `migration/`, and `meridian-governance-backup/` are local artifacts, not canonical GitHub systems;
- `bumblebee` is external open-source code and must not be presented as MHK-owned source.

Always record `origin URL + ref + full SHA + worktree status` before drawing architectural conclusions or changing code.

## 17. Institutional knowledge, known unknowns, and maintenance protocol

### 17.1 Ten-year truths worth carrying into every task

1. **The database is an integration surface.** Core Hibernate mappings/Flyway and MP Oracle objects have consumers in jobs, adapters, reports, extracts and client overlays. Schema changes are never “only persistence.”
2. **Configuration is executable product behavior.** System variables, reference rows, permissions, templates, client adapters, YAML, scheduler XML and Terraform inputs can change semantics without a shared-code change.
3. **Compliance lives in timers and artifacts.** Due dates, assignment, alerts, required data, audit history, correspondence, effectuation and reports implement regulatory obligations.
4. **MHK supports multiple generations at once.** GWT and React; SOAP and REST/FHIR; files and events; Spago and Knowage/QuickSight; Jenkins/GitLab and GitHub/CodeBuild; Java 6-era models and Java 21 services can coexist by release/client.
5. **A product is rarely one repository.** Document AI, DataVisor, correspondence, Provider Portal, criteria, PBM ePA and interoperability are cross-repository capabilities.
6. **A repository is rarely one deployable.** Core and the monorepos contain independently built modules; batch has no meaningful “run everything” assumption.
7. **Client variation is structural, not exceptional.** Shared product behavior plus client adapters/configuration/templates/schedules is the normal architecture.
8. **Names carry history.** `MedHOK`, `medhok20`, `MedicalMgmt`, `correspondance`, `CareWebQI`, `Spago`, and versioned adapter names persist because code, DB, artifacts and deployments depend on them.
9. **Portal is an audience word, not a component name.** Ask internal operator, provider, beneficiary, enrollment, billing, interop self-service, third-party portal, or platform administration.
10. **Success is stage-specific.** Receipt, validation, case creation, decision, effectuation, correspondence and reporting each have independent failure/retry semantics.
11. **Default branch is development evidence, not client truth.** Client release branch, built artifact, migration level and effective configuration decide behavior.
12. **Operational glue is part of the system.** Skybot, InfAuto, filesystem/SFTP/S3, archives, credentials, host inventory and monitoring can be the actual failure point.
13. **AI does not remove deterministic authority.** Eligibility, workflow, clinical/compliance rules, SQL safety, schema validation and human determinations remain explicit control points.
14. **Production data belongs in production evidence systems, not prompts.** Use sanitized IDs/metadata and approved tools; never expand general organizational context with PHI/PII or secrets.

### 17.2 Questions this source snapshot cannot answer

- Which exact code/config/database version is deployed for each client/environment right now?
- Which clients license or enable a particular module, PBM adapter, portal, criteria vendor, ePA network or AI workflow?
- Which scheduler definitions are enabled and which InfAuto versions are installed on each agent?
- Which retained GitLab/Jenkins paths remain authoritative versus migrated GitHub/CodeBuild paths?
- Who currently owns each product, repository, on-call rotation and vendor relationship?
- Which report artifact/promotion path is authoritative for every client and report family?
- Which DataVisor dashboards/datasets are customer-facing, and which query-agent experiments are internal only?
- Which Document AI mode/workflow version is selected per client?
- What are the live SLOs, queue depths, retention rules, costs, model versions and failure rates?
- Which MP hosting/deployment path is active for each application and client?

For these questions, state **[UNKNOWN]** and retrieve live evidence. Do not fill a gap with a plausible architecture story.

### 17.3 How an agent should answer with this context

1. Name the product estate and business domain.
2. State whether the answer is product intent, checked-in code, runtime fact, inference or unknown.
3. Give the likely owning repository/module plus the adjacent contract/configuration owners.
4. Explain the end-to-end handoffs and the stable IDs needed to trace them.
5. Call out client/release/configuration dependence.
6. For diagnosis, request or retrieve exact timestamp, environment, branch/artifact, error text and correlation handle.
7. For a proposed fix, identify cross-repo/schema/report/batch compatibility and a verification route.
8. Do not claim a client uses a capability until effective configuration or runtime proves it.

### 17.4 Maintaining this file

When refreshing this context:

- advance `evidence_snapshot` and update repository counts/SHAs only from a fresh authenticated inventory;
- keep the document self-contained—do not make another private research file mandatory to understand a claim;
- tag material claims by evidence type and retain uncertainty;
- add aliases and exact retrieval handles when organizational vocabulary changes;
- never copy secret values, private endpoints, account IDs, raw logs, PHI/PII, client documents or credential-like examples;
- separate architecture changes from live deployment confirmation;
- mark archived/replaced lineages without erasing them, because incidents and old release branches still reference them;
- validate internal paths, external links, heading structure, duplicate/conflicting definitions and high-risk absolutes before publishing.

## 18. Evidence and retrieval index

### 18.1 Canonical source baselines used for deep inspection

These are dated source coordinates, not deployment coordinates:

| System | Baseline inspected |
|---|---|
| CareProminence Core | `cp-medhok-monorepo origin/master@2ef25b7c3571166591db61fe18cb15a5d6802774` |
| Batch | `cp-batch-monorepo origin/master@f05c8d57cdf5ac753b714d6957f61e1f6a9d9639` |
| Client adapters | `cp-client-services-monorepo origin/master@d06de49fd75169e714b11e69763d628eb3222a4a` |
| SmartProminence React app | `cp-mhk-smart-prominence origin/main@1ca9da873ca45f19f7370518db0e90084e3ff08b` |
| Enterprise AI Agent Platform | `enterprise-ai-agent-platform origin/master@cb32f1a70523401cc2e4735488d0424d2534ddb4` |
| Specter | `cp-autonomous-ai-agents-platform origin/main@4deef6cc12a419e88cbe7c6a198cf688f291cb79` |
| Build platform | `cp-build-platform origin/main@7771ae187ea3004959e11b4864b5f2fc06257eb1` |
| Client/environment configuration | `cp-configurations origin/main@06455b6622343c5c7f6c7358f05d127e4c8736a6` |
| Interoperability | `cp-interoperability-monorepo origin/main@1d420ba7ef1e7e79a99ee4cc38fb556748396c7c` |
| Operational reporting | `cp-medhok20-cloudwatch origin/main@098f495903c1c64cd84aee06552462257c6470c1` |

### 18.2 High-value code retrieval handles

- **Core architecture:** `cp-medhok-monorepo/MedicalMgmt/`, `MedicalMgmtModels/`, `medhok-web-services/`, `medhok-vendor-services/`, `mhk-fhir-server/`, `flyway/sql/`.
- **Core modern boundary:** `cp-medhok-monorepo/MedicalMgmt/src/main/java/com/medhok/mm/server/bff/` and `cp-mhk-smart-prominence/src/`.
- **Pharmacy/ePA:** search Core for `EPAService`, `RxPARestServices`, `WebServiceTransactionNcpdp`, `NcpdpEpaCaseMatchConfig`, `DrugException`; search batch for `epa-`, `ncpdp`, `epaReport`; inspect the selected PBM adapter.
- **Criteria:** search Core for `CareWebQIService`, `CareWebQiConfigurationController`, `InterqualConfigurationController`, `applyGuidelineOutcome`, `EXTERNALGUIDELINES_MCG`, `EXTERNALGUIDELINES_IQ`; adjacent MCG module is under `cp-medhok20-services-monorepo/mcg-service`; legacy batch directory is `carewebql-service` (lowercase final `l` in the path).
- **Provider Portal:** `cp-provider-portal/ProviderPortal/` plus offline client/service and shared screen-definition modules; Core `PortalService`, `PortalUser*`, `ProviderPortalConfiguration*`, portal Flyway migrations, and `cp-batch-monorepo/EventProcessing/src/main/java/com/medhok/EventProcessing/dao/PortalEventProcessingDao.java`.
- **Batch:** top-level `cp-batch-monorepo/<module>/pom.xml`; no aggregate-build assumption. OCR seam: `cp-batch-monorepo/medhok-ocr-manager/`.
- **Client adapters:** `cp-client-services-monorepo/<mm-service-*>/`, `ExternalClientRestServices/`, `ExternalClientServicesModel/`, WSDL/XSD and `externalcallouts.xml`.
- **Schedule/config:** `cp-product-scheduler-times/README.md`, client XML and workflows; `cp-product-client-configs/README.md`, region/client/env YAML and promotion workflows.
- **Interop:** `cp-interoperability-monorepo/mhk-interopt-fhirhelper/`, `lambdas/fhir_processor/`, `lambdas/health_lake_exporter/`, `lambdas/smart_introspection/`, Terraform modules.
- **Data/reporting:** `cp-datalake-pipeline/ETL/`, materialized views, Terraform/QuickSight; `cp-medhok-data-extract-monorepo/`; `cp-medhok-bi-datamart-monorepo/`; `cp-bi-report-catalog/`; `cp-compliance-reporting-monorepo/`; `cp-hedis-monorepo/`.
- **Product AI:** `enterprise-ai-agent-platform/controller-agents/`, `processing-agents/`, `terraform/`, `ui-portal/`; standalone lineage `document-ai/`.
- **Engineering AI:** `cp-autonomous-ai-agents-platform/src/`, `docs/ONESHOT_RUNBOOK.md`, `docs/spec-factory/`, `SPECTER_OVERVIEW.md`; separate lineage `mhk-project-one-shot/`.
- **Delivery/ops:** `cp-build-platform/`, `cp-configurations/`, `cp-devops-jenkins-automated-deploy/Jenkinsfile`, `config/`, `scripts/`; `cp-medhok20-cloudwatch/`; relevant `infauto-*` runner.
- **MarketProminence:** `mp-core-database/` schema/setup/upgrades; `mp-web/`; `mp-connect/`; corresponding portal UI/API/database/client family; MP Jenkins/deployment/Terraform repos.

### 18.3 Official product sources

- [MHK solutions overview](https://mhk.com/)
- [About MHK](https://mhk.com/about-us/)
- [Who MHK serves](https://mhk.com/who-we-serve/)
- [Utilization Management](https://mhk.com/solutions/mhk-careprominence/utilization-management-suite/)
- [Care Management](https://mhk.com/solutions/mhk-careprominence/care-management-suite/)
- [Complaints, Appeals and Grievances](https://mhk.com/solutions/mhk-careprominence/complaints-appeals-and-grievances-suite/)
- [Pharmacy Management](https://mhk.com/solutions/mhk-careprominence/pharmacy-management-suite/)
- [Population Health and Quality](https://mhk.com/solutions/mhk-careprominence/population-health-quality-management/)
- [MHK Interoperability](https://mhk.com/solutions/mhk-careprominence/mhk-interop-suite/)
- [DataVisor](https://mhk.com/solutions/mhk-careprominence/data-visor-insights-and-analytics-for-payers/)
- [SmartProminence Orchestrator](https://mhk.com/solutions/mhk-careprominence/solutions-mhk_smartprominence/)
- [MarketProminence Enrollment and Member Maintenance](https://mhk.com/solutions/mhk-marketprominence/enrollment-member-maintenance/)
- [MarketProminence Premium Billing](https://mhk.com/solutions/mhk-marketprominence/premium-billing/)
- [MarketProminence Financial Reconciliation](https://mhk.com/solutions/mhk-marketprominence/financial-reconciliation/)
- [MarketProminence Web Portals](https://mhk.com/solutions/mhk-marketprominence/web-portals/)

The final operating rule is simple: use this document to know **where and how to investigate**, then use current source, configuration and runtime evidence to know **what is true for the client now**.
