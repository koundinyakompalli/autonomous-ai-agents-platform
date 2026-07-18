import { describe, expect, it } from "vitest";
import { redactSensitiveObject, redactSensitiveText } from "./redaction.js";

describe("Spec Factory redaction", () => {
  it("redacts common secret assignments and bearer tokens in text", () => {
    expect(
      redactSensitiveText(
        "JIRA_TOKEN=abc123\npassword: hunter2\nAuthorization: Bearer secret-token",
      ),
    ).toBe(
      "JIRA_TOKEN=[REDACTED]\npassword: [REDACTED]\nAuthorization: Bearer [REDACTED]",
    );
  });

  it("redacts nested object string values and sensitive keys", () => {
    expect(
      redactSensitiveObject({
        token: "abc123",
        nested: {
          note: "api_key=secret-value",
        },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: {
        note: "api_key=[REDACTED]",
      },
    });
  });

  it("redacts value-shaped secrets even when key names are benign", () => {
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7secret",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNTE2MjM5MDIyfQ.signaturebits";
    const text = [
      "db_conn=postgres://user:pass@db.example.com:5432/app",
      "aws=AKIAIOSFODNN7EXAMPLE",
      "github=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      `jwt=${jwt}`,
      privateKey,
      "curl -H 'Bearer sk-live-1234567890abcdef' https://api.example.com",
    ].join("\n");

    const redacted = redactSensitiveText(text);

    expect(redacted).not.toContain("postgres://user:pass@");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).not.toContain("sk-live-1234567890abcdef");
    expect(redacted).toContain("db_conn=[REDACTED]");
  });
});
