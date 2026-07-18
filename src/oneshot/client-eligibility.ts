export const CLIENT_ELIGIBILITY_JIRA_EXPAND = [
  "names",
  "customfield_10769.cmdb.label",
  "customfield_10769.cmdb.attributes",
].join(",");

const CANONICAL_CLIENT_FIELD_NAMES = [
  "Client",
  "client",
  "customfield_10769",
] as const;

const LEGACY_CUSTOMER_FIELD_NAMES = [
  "Customer",
  "customer",
  "customfield_10047",
  "customfield_10002",
] as const;

export const CLIENT_FIELD_NAMES = [
  ...CANONICAL_CLIENT_FIELD_NAMES,
  ...LEGACY_CUSTOMER_FIELD_NAMES,
] as const;

const CLIENT_FIELD_DISPLAY_NAME_PATTERN = /^client$/i;
const CUSTOMER_FIELD_DISPLAY_NAME_PATTERN = /^customer$/i;
const CLIENT_LABEL_PATTERN = /^(?:client|customer):(.+)$/i;

const POLICY_UNAVAILABLE_ERROR_CODES = new Set([
  "ER_NO_SUCH_TABLE",
  "ER_BAD_FIELD_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_ACCESS_DENIED_ERROR",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
]);

export interface ClientEligibilityJiraIssue {
  key?: string;
  names?: Record<string, string>;
  fields?: {
    labels?: unknown;
    [key: string]: unknown;
  };
}

export interface ClientEligibilityQueryExecutor {
  query<T extends unknown[] = Record<string, unknown>[]>(
    sql: string,
    params?: unknown[],
  ): Promise<[T, unknown]>;
}

export interface ClientEligibilityLogger {
  warn(
    payload: Record<string, unknown>,
    message: string,
  ): void;
}

export type ClientEligibilityResult =
  | {
      status: "unknown_client";
      eligible: true;
      clientName: null;
      clientKey: null;
    }
  | {
      status: "eligible";
      eligible: true;
      clientName: string;
      clientKey: string;
    }
  | {
      status: "ineligible";
      eligible: false;
      clientName: string;
      clientKey: string;
      blockedClientDisplayName: string;
      reason: string | null;
    }
  | {
      status: "policy_unavailable";
      eligible: true;
      clientName: string;
      clientKey: string;
      errorMessage: string;
    };

type BlockedClientPolicyRow = {
  client_key: string;
  display_name: string;
  reason: string | null;
};

export function normalizeClientKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || null;
}

export function normalizeClientDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function jiraAssetAttributeValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const attribute = record.objectTypeAttribute;
  const attributeRecord =
    attribute && typeof attribute === "object"
      ? (attribute as Record<string, unknown>)
      : {};
  const attributeName = stringValue(attributeRecord.name);
  const isClientNameAttribute =
    attributeRecord.label === true ||
    attributeName?.trim().toLowerCase() === "preferred name";

  if (!isClientNameAttribute) {
    return null;
  }

  const attributeValues = Array.isArray(record.objectAttributeValues)
    ? record.objectAttributeValues
    : [];
  for (const attributeValue of attributeValues) {
    if (!attributeValue || typeof attributeValue !== "object") {
      const valueText = stringValue(attributeValue);
      if (valueText) {
        return valueText;
      }
      continue;
    }
    const valueRecord = attributeValue as Record<string, unknown>;
    const extracted =
      stringValue(valueRecord.value) ||
      stringValue(valueRecord.displayValue) ||
      stringValue(valueRecord.searchValue);
    if (extracted) {
      return extracted;
    }
  }

  return stringValue(record.value);
}

function jiraAssetAttributesValue(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const attribute of value) {
    const extracted = jiraAssetAttributeValue(attribute);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = stringValue(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      stringValue(record.label) ||
      jiraAssetAttributesValue(record.attributes) ||
      stringValue(record.value) ||
      stringValue(record.name) ||
      stringValue(record.displayName)
    );
  }

  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function isClientFieldDisplayName(value: string): boolean {
  return CLIENT_FIELD_DISPLAY_NAME_PATTERN.test(value.trim());
}

function isCustomerFieldDisplayName(value: string): boolean {
  return CUSTOMER_FIELD_DISPLAY_NAME_PATTERN.test(value.trim());
}

function extractFromFieldNames(
  fields: Record<string, unknown>,
  fieldNames: readonly string[],
): string | null {
  for (const fieldName of fieldNames) {
    const value = stringValue(fields[fieldName]);
    if (value) {
      return value;
    }
  }
  return null;
}

function extractFromNamedFields(
  fields: Record<string, unknown>,
  names: Record<string, string> | undefined,
  predicate: (displayName: string) => boolean,
): string | null {
  for (const [fieldName, displayName] of Object.entries(names ?? {})) {
    if (!predicate(displayName)) {
      continue;
    }
    const value = stringValue(fields[fieldName]);
    if (value) {
      return value;
    }
  }
  return null;
}

export function extractClientNameFromJiraIssue(
  issue: ClientEligibilityJiraIssue,
): string | null {
  const fields = issue.fields;
  if (!fields) {
    return null;
  }

  const canonicalClient =
    extractFromFieldNames(fields, CANONICAL_CLIENT_FIELD_NAMES) ||
    extractFromNamedFields(fields, issue.names, isClientFieldDisplayName);
  if (canonicalClient) {
    return canonicalClient;
  }

  const legacyCustomer =
    extractFromFieldNames(fields, LEGACY_CUSTOMER_FIELD_NAMES) ||
    extractFromNamedFields(fields, issue.names, isCustomerFieldDisplayName);
  if (legacyCustomer) {
    return legacyCustomer;
  }

  for (const label of stringArray(fields.labels)) {
    const match = label.match(CLIENT_LABEL_PATTERN);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export function isPolicyStoreUnavailableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException & { code?: string })?.code;
  return Boolean(code && POLICY_UNAVAILABLE_ERROR_CODES.has(code));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function evaluateClientEligibility(
  issue: ClientEligibilityJiraIssue,
  executor: ClientEligibilityQueryExecutor,
  logger?: ClientEligibilityLogger,
): Promise<ClientEligibilityResult> {
  const clientName = extractClientNameFromJiraIssue(issue);
  const clientKey = normalizeClientKey(clientName);

  if (!clientName || !clientKey) {
    return {
      status: "unknown_client",
      eligible: true,
      clientName: null,
      clientKey: null,
    };
  }

  let rows: BlockedClientPolicyRow[];
  try {
    [rows] = await executor.query<BlockedClientPolicyRow[]>(
      "SELECT client_key, display_name, reason FROM oneshot_blocked_clients WHERE client_key = ? AND is_active = TRUE LIMIT 1",
      [clientKey],
    );
  } catch (error) {
    if (!isPolicyStoreUnavailableError(error)) {
      throw error;
    }
    logger?.warn(
      {
        jiraKey: issue.key,
        clientKey,
        error: errorMessage(error),
      },
      "Blocked-client policy store is unavailable; allowing OneShot intake to continue",
    );
    return {
      status: "policy_unavailable",
      eligible: true,
      clientName,
      clientKey,
      errorMessage: errorMessage(error),
    };
  }

  const blockedClient = rows[0];
  if (!blockedClient) {
    return {
      status: "eligible",
      eligible: true,
      clientName,
      clientKey,
    };
  }

  return {
    status: "ineligible",
    eligible: false,
    clientName,
    clientKey,
    blockedClientDisplayName: blockedClient.display_name,
    reason: blockedClient.reason ?? null,
  };
}
