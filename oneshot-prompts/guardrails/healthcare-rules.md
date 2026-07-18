# Healthcare & FHIR Implementation Guidelines

**Version:** 2.0.0
**Purpose:** Domain-specific guardrails for healthcare projects — conditionally loaded when ONESHOT_HEALTHCARE_GUARDRAILS=true

---

## Overview

These domain-specific guidelines supplement the stage guardrails. When healthcare mode is enabled, this content is appended to all stage prompts to ensure HIPAA compliance, FHIR standards, and clinical safety.

---

## Severity Levels

| Level | Action Required | Healthcare Context |
|-------|-----------------|-------------------|
| **CRITICAL** | Block until resolved | HIPAA violations, PHI exposure, compliance failures |
| **HIGH** | Address before implementation | Missing audit trails, FHIR non-compliance |
| **MEDIUM** | Recommend fixing | Best practices, versioning, documentation |
| **LOW** | Informational | Code style, minor improvements |

---

## 1. PHI Protection & HIPAA Compliance

### Rule 1.1: No PHI in Logs
**Severity:** CRITICAL
**Description:** Never log Protected Health Information (PHI) in application logs.

**PHI Includes:**
- Patient names, Social Security Numbers (SSN), Date of Birth (DOB)
- Medical Record Numbers (MRN), diagnoses or clinical data
- Phone numbers, addresses, emails (when linked to patient)

**What to Check:**
- Search for logger calls with PHI patterns
- Look for string concatenation with patient/person objects
- Check for logging of request/response bodies containing PHI

**Good Example:**
```java
// Log only IDs, not PHI
logger.info("Processing authorization for patient [id={}]", patientId);
```

**Bad Example:**
```java
// PHI exposed in logs
logger.info("Processing authorization for patient: " + patient.getName());
```

---

### Rule 1.2: PHI Encryption at Rest
**Severity:** CRITICAL
**Description:** All PHI stored in databases must be encrypted at rest.

**What to Check:**
- New database columns storing PHI without encryption
- Entity fields containing PHI without encryption converters

---

### Rule 1.3: Audit Trail for PHI Access
**Severity:** HIGH
**Description:** All PHI access must be logged in an audit trail.

**What to Check:**
- Methods returning PHI should have audit logging
- FHIR resource reads should trigger audit events

---

## 2. FHIR R4 Standards Compliance

### Rule 2.1: Required FHIR Fields
**Severity:** HIGH
**Description:** All FHIR resources must include required fields per R4 specification.

**What to Check:**
- Patient: identifier (required with system + value)
- Observation: status, code, subject (required)
- Check FHIR resource constructors for required fields

### Rule 2.2: FHIR Data Types
**Severity:** MEDIUM
**Description:** Use proper FHIR data types (CodeableConcept, Reference, etc.).

### Rule 2.3: FHIR Resource Validation
**Severity:** HIGH
**Description:** Validate FHIR resources before returning them from endpoints.

---

## 3. Clinical API Versioning

### Rule 3.1: API Version in Path
**Severity:** MEDIUM
**Description:** Clinical APIs must use version prefix in URL path (e.g., `/api/v2/`).

### Rule 3.2: Deprecation Period
**Severity:** HIGH
**Description:** Maintain deprecated clinical APIs for minimum 6 months before removal.

---

## 4. Maven/Dependency Consistency

### Rule 4.1: HAPI FHIR Version Consistency
**Severity:** MEDIUM
**Description:** All HAPI FHIR dependencies must use the same version. Use a property for version management.

---

## 5. Transaction Safety for Clinical Data

### Rule 5.1: @Transactional for Clinical Updates
**Severity:** HIGH
**Description:** All clinical data updates must be wrapped in transactions.

### Rule 5.2: Rollback on All Exceptions
**Severity:** MEDIUM
**Description:** Clinical transactions should specify rollbackFor to ensure rollback on any exception.

---

## 6. Error Handling for Clinical Systems

### Rule 6.1: Patient-Safe Error Messages
**Severity:** CRITICAL
**Description:** Error messages returned to clients must not expose PHI. Log detailed errors server-side with IDs only.

---

## 7. Data Validation

### Rule 7.1: Validate Medical Codes
**Severity:** MEDIUM
**Description:** Validate ICD-10, CPT, NDC codes against standard code sets before persisting.

### Rule 7.2: Logical Date Ranges
**Severity:** MEDIUM
**Description:** Validate healthcare dates are logical (no future birth dates, end dates after start dates).

---

## 8. Consent Management

### Rule 8.1: Consent Verification Before PHI Access
**Severity:** CRITICAL
**Description:** Verify patient consent before accessing or sharing PHI. Check consent status, scope, and expiration.

### Rule 8.2: Consent Scope Validation
**Severity:** HIGH
**Description:** Ensure data access matches the scope of granted consent (TREATMENT, PAYMENT, OPERATIONS, RESEARCH, MARKETING).

### Rule 8.3: Consent Revocation Handling
**Severity:** HIGH
**Description:** Properly handle consent revocation: stop future access, maintain audit trail, notify downstream systems.

---

## 9. SMART on FHIR Authorization

### Rule 9.1: OAuth 2.0 Scope Validation
**Severity:** CRITICAL
**Description:** FHIR endpoints must validate bearer token scopes following SMART specification (e.g., `patient/Patient.read`, `user/MedicationRequest.*`).

### Rule 9.2: Launch Context Validation
**Severity:** HIGH
**Description:** Validate SMART launch context parameters (patient, encounter, fhirUser, intent).

### Rule 9.3: Token Introspection for Clinical Operations
**Severity:** HIGH
**Description:** Introspect tokens for sensitive write operations on clinical resources.

### Rule 9.4: Refresh Token Security
**Severity:** HIGH
**Description:** Refresh tokens must be stored encrypted with rotation implemented. Revocation invalidates all associated tokens.

---

## Validation Checklist

### PHI & HIPAA (Section 1)
- CRITICAL: No PHI in logs — only IDs logged
- CRITICAL: PHI encryption at rest
- HIGH: Audit trails for PHI access

### FHIR Compliance (Section 2)
- HIGH: Required fields populated
- MEDIUM: Proper FHIR data types
- HIGH: Resources validated before return

### Clinical APIs (Section 3)
- MEDIUM: Versioned URLs
- HIGH: Deprecation period maintained

### Transaction Safety (Section 5)
- HIGH: Clinical updates in transactions
- MEDIUM: Explicit rollback policy

### Error Handling (Section 6)
- CRITICAL: Patient-safe error messages

### Consent (Section 8)
- CRITICAL: Consent verification before PHI access
- HIGH: Consent scope validation
- HIGH: Revocation handling

### SMART on FHIR (Section 9)
- CRITICAL: OAuth scope validation
- HIGH: Launch context validation
- HIGH: Token introspection
- HIGH: Refresh token security
