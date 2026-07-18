import { describe, expect, it } from "vitest";
import {
  resolveDatabaseConfig,
  resolveDatabaseSslOptions,
} from "./database.js";

describe("resolveDatabaseConfig", () => {
  it("fails closed when the database password is missing or blank", () => {
    expect(() => resolveDatabaseConfig({})).toThrow(
      "database_configuration_invalid:DB_PASSWORD_required",
    );
    expect(() => resolveDatabaseConfig({ DB_PASSWORD: "   " })).toThrow(
      "database_configuration_invalid:DB_PASSWORD_required",
    );
  });

  it("uses the explicit password with local tunnel defaults", () => {
    expect(resolveDatabaseConfig({ DB_PASSWORD: "local-secret" })).toEqual({
      host: "localhost",
      port: 13306,
      user: "document_ai_admin",
      password: "local-secret",
      database: "Specter",
      connectionLimit: 5,
      ssl: undefined,
    });
  });

  it("uses production defaults and preserves TLS configuration", () => {
    expect(
      resolveDatabaseConfig({
        NODE_ENV: "production",
        DB_PASSWORD: "runtime-secret",
        DB_SSL: "true",
      }),
    ).toEqual({
      host: "specter-rds.amazonaws.com",
      port: 3306,
      user: "document_ai_admin",
      password: "runtime-secret",
      database: "Specter",
      connectionLimit: 10,
      ssl: { rejectUnauthorized: true },
    });
  });
});

describe("resolveDatabaseSslOptions", () => {
  it("leaves existing non-proxy connections unchanged by default", () => {
    expect(resolveDatabaseSslOptions({})).toBeUndefined();
  });

  it("enables verified TLS for RDS Proxy connections", () => {
    expect(resolveDatabaseSslOptions({ DB_SSL: "true" })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("supports an explicit emergency verification override", () => {
    expect(
      resolveDatabaseSslOptions({
        DB_SSL: "yes",
        DB_SSL_REJECT_UNAUTHORIZED: "false",
      }),
    ).toEqual({ rejectUnauthorized: false });
  });
});
