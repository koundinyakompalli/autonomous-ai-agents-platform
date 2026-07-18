import { describe, expect, it, vi } from "vitest";
import {
  evaluateClientEligibility,
  extractClientNameFromJiraIssue,
  normalizeClientKey,
} from "./client-eligibility.js";

describe("client eligibility policy", () => {
  it("normalizes client keys with case-insensitive collapsed whitespace", () => {
    expect(normalizeClientKey("  Blocked   Corp  ")).toBe("blocked corp");
    expect(normalizeClientKey("\tBLOCKED\nCorp\t")).toBe("blocked corp");
    expect(normalizeClientKey("")).toBeNull();
    expect(normalizeClientKey("   ")).toBeNull();
  });

  it("extracts clients from named fields, custom fields, arrays, objects, and labels", () => {
    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-1",
        fields: { customer: "Customer Field" },
      }),
    ).toBe("Customer Field");

    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-2",
        fields: { Customer: { value: "Object Customer" } },
      }),
    ).toBe("Object Customer");

    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-3",
        fields: { Client: [{ name: "Array Client" }] },
      }),
    ).toBe("Array Client");

    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-4",
        names: { customfield_12345: "Client" },
        fields: { customfield_12345: { displayName: "Named Client" } },
      }),
    ).toBe("Named Client");

    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-5",
        fields: { labels: ["Client: Label Client"] },
      }),
    ).toBe("Label Client");
  });

  it("prefers Jira Assets Client over legacy Customer fields", () => {
    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-23724",
        names: {
          customfield_10769: "Client",
          customfield_10047: "Customer",
          customfield_10100: "Solution/Feature",
        },
        fields: {
          customfield_10769: [
            {
              label: "Centene CP",
              objectKey: "CA-39933",
              attributes: [
                {
                  objectTypeAttribute: { name: "Preferred Name" },
                  objectAttributeValues: [
                    { value: "Centene CP", displayValue: "Centene CP" },
                  ],
                },
              ],
            },
          ],
          customfield_10047: [{ value: "Centene (WellCare) CP" }],
          customfield_10100: [{ value: "RX - Pharmacy" }],
        },
      }),
    ).toBe("Centene CP");
  });

  it("falls back to legacy Customer fields when Jira Assets Client is absent", () => {
    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-legacy",
        names: {
          customfield_10047: "Customer",
        },
        fields: {
          customfield_10047: [{ value: "Centene (WellCare) CP" }],
        },
      }),
    ).toBe("Centene (WellCare) CP");
  });

  it("does not treat Solution/Feature as a client", () => {
    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-solution",
        names: {
          customfield_10100: "Solution/Feature",
        },
        fields: {
          customfield_10100: [{ value: "RX - Pharmacy" }],
        },
      }),
    ).toBeNull();
  });

  it("extracts Jira Assets Preferred Name when no top-level label is present", () => {
    expect(
      extractClientNameFromJiraIssue({
        key: "CPDEV-assets",
        names: {
          customfield_10769: "Client",
        },
        fields: {
          customfield_10769: [
            {
              objectKey: "CA-39933",
              attributes: [
                {
                  objectTypeAttribute: { name: "Preferred Name" },
                  objectAttributeValues: [
                    { value: "Centene CP", displayValue: "Centene CP" },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ).toBe("Centene CP");
  });

  it("returns unknown_client without querying policy when no client is present", async () => {
    const query = vi.fn();

    await expect(
      evaluateClientEligibility(
        { key: "CPDEV-10", fields: { labels: ["PFOS"] } },
        { query },
      ),
    ).resolves.toEqual({
      status: "unknown_client",
      eligible: true,
      clientName: null,
      clientKey: null,
    });

    expect(query).not.toHaveBeenCalled();
  });

  it("requires an exact normalized match to block a client", async () => {
    const query = vi.fn().mockResolvedValueOnce([[]]);

    await expect(
      evaluateClientEligibility(
        { key: "CPDEV-11", fields: { Client: "Blocked Corporation" } },
        { query },
      ),
    ).resolves.toMatchObject({
      status: "eligible",
      eligible: true,
      clientName: "Blocked Corporation",
      clientKey: "blocked corporation",
    });

    expect(query).toHaveBeenCalledWith(
      "SELECT client_key, display_name, reason FROM oneshot_blocked_clients WHERE client_key = ? AND is_active = TRUE LIMIT 1",
      ["blocked corporation"],
    );
  });

  it("returns ineligible when the normalized client key is active on the policy table", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          client_key: "blocked corp",
          display_name: "Blocked Corp",
          reason: "Contract exclusion",
        },
      ],
    ]);

    await expect(
      evaluateClientEligibility(
        { key: "CPDEV-12", fields: { client: "  BLOCKED   CORP " } },
        { query },
      ),
    ).resolves.toEqual({
      status: "ineligible",
      eligible: false,
      clientName: "BLOCKED   CORP",
      clientKey: "blocked corp",
      blockedClientDisplayName: "Blocked Corp",
      reason: "Contract exclusion",
    });
  });

  it("fails open when the policy store is unavailable", async () => {
    const error = Object.assign(new Error("Table does not exist"), {
      code: "ER_NO_SUCH_TABLE",
    });
    const query = vi.fn().mockRejectedValueOnce(error);

    await expect(
      evaluateClientEligibility(
        { key: "CPDEV-13", fields: { Client: "Blocked Corp" } },
        { query },
      ),
    ).resolves.toMatchObject({
      status: "policy_unavailable",
      eligible: true,
      clientName: "Blocked Corp",
      clientKey: "blocked corp",
    });
  });
});
