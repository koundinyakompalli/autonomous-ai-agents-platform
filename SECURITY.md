# Security Policy

## Supported Branches

Security fixes are accepted for the active default branch (`main` or `master`)
and release branches that are still deployed or otherwise supported by the
platform team.

## Reporting a Vulnerability

Do not report vulnerabilities through public issues, pull request comments, or
chat channels that include unredacted secrets, PHI, PII, credentials, tokens, or
customer data.

Use the private GitHub security advisory flow for this repository when it is
enabled. If private reporting is not available, route the report through the MHK
security, AI governance, or incident-response process and include:

- affected component and environment
- reproduction steps or evidence
- impact assessment
- whether secrets, PHI, PII, customer data, or production access are involved
- recommended remediation, if known

## Response Targets

| Severity | Initial triage   | Target remediation posture         |
| -------- | ---------------- | ---------------------------------- |
| Critical | 1 business day   | block release or patch immediately |
| High     | 2 business days  | remediate within 7 days            |
| Medium   | 5 business days  | remediate within 30 days           |
| Low      | 10 business days | schedule through normal backlog    |

These targets are operational guidance for engineering triage, not a legal
attestation. Actual timelines may be adjusted for exploitability, compensating
controls, client impact, and change-control requirements.

## Handling Requirements

- Keep production-impacting fixes behind normal review, DBA approval, release,
  and change-control paths.
- Redact secrets, PHI, PII, tokens, and customer identifiers from tickets,
  comments, screenshots, logs, and generated artifacts unless the approved
  handling process explicitly allows them.
- Rotate any exposed secret instead of only deleting it from the repository.
- Record accepted risk and scanner suppressions with dated justification and an
  owner.
