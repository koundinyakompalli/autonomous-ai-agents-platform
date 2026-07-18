export const MAVEN_SMOKE_REQUIRED_ENV = [
  "ARTIFACTORY_HOST",
  "MAVEN_USER",
  "MAVEN_PASSWORD",
];

export const DEFAULT_MAVEN_SETTINGS_CANDIDATES = [
  "local-oneshot/data/repo-admin/core-app/.m2/settings.xml",
  "local-oneshot/data/repositories/core-app/.m2/settings.xml",
];

function trimmed(value) {
  return String(value ?? "").trim();
}

export function isMavenBuildsEnabledEnv(env = process.env) {
  const value = trimmed(env.ONESHOT_MAVEN_BUILDS_ENABLED).toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

export function inspectMavenSmokeEnvironment(env = process.env) {
  const host = trimmed(env.ARTIFACTORY_HOST);
  const malformedHostReasons = [];
  if (!host) {
    malformedHostReasons.push("missing");
  }
  if (String(env.ARTIFACTORY_HOST ?? "") !== host || /\s/.test(host)) {
    malformedHostReasons.push("contains_whitespace");
  }
  if (/^https?:\/\//i.test(host)) {
    malformedHostReasons.push("contains_protocol");
  }
  if (host.includes("/")) {
    malformedHostReasons.push("contains_path");
  }
  if (/\/artifactory(?:\/|$)/i.test(host)) {
    malformedHostReasons.push("contains_artifactory_path");
  }

  return {
    ARTIFACTORY_HOST: {
      present: Boolean(host),
      hostOnly: Boolean(host) && malformedHostReasons.length === 0,
      malformedHostReasons,
    },
    MAVEN_USER: {
      present: Boolean(trimmed(env.MAVEN_USER)),
    },
    MAVEN_PASSWORD: {
      present: Boolean(trimmed(env.MAVEN_PASSWORD)),
    },
  };
}

export function validateMavenSettingsExpansion(settingsXml, env = process.env) {
  const errors = [];
  const content = String(settingsXml ?? "");
  const referencesArtifactoryHost = content.includes("${env.ARTIFACTORY_HOST}");
  if (!referencesArtifactoryHost) {
    return { errors, referencesArtifactoryHost };
  }

  const host = trimmed(env.ARTIFACTORY_HOST);
  const expanded = content.replaceAll("${env.ARTIFACTORY_HOST}", host);
  if (expanded.includes("https:///artifactory")) {
    errors.push(
      "Repo-local Maven settings reference ${env.ARTIFACTORY_HOST}; without ARTIFACTORY_HOST they expand to https:///artifactory.",
    );
  }
  return { errors, referencesArtifactoryHost };
}

export function validateMavenSmokeEnvironment(
  env = process.env,
  options = {},
) {
  const fullDelivery = Boolean(options.fullDelivery);
  const skipMavenPreflight = Boolean(options.skipMavenPreflight);
  const mavenBuildsEnabled =
    options.mavenBuildsEnabled ?? isMavenBuildsEnabledEnv(env);
  const settingsXmlContents = options.settingsXmlContents ?? [];
  const diagnostics = inspectMavenSmokeEnvironment(env);
  const warnings = [];
  const errors = [];

  if (!mavenBuildsEnabled) {
    return {
      ok: true,
      errors,
      warnings,
      diagnostics: {
        ...diagnostics,
        mavenBuildsEnabled: false,
      },
      skipped: true,
      skipReason: "maven_builds_disabled",
    };
  }

  if (!fullDelivery || skipMavenPreflight) {
    for (const name of MAVEN_SMOKE_REQUIRED_ENV) {
      if (!diagnostics[name].present) {
        warnings.push(
          `${name} is not set; MedHOK Maven/test validation may fail during full delivery.`,
        );
      }
    }
    return {
      ok: true,
      errors,
      warnings,
      diagnostics,
      skipped: skipMavenPreflight,
    };
  }

  for (const name of MAVEN_SMOKE_REQUIRED_ENV) {
    if (!diagnostics[name].present) {
      errors.push(
        `${name} is required for --execute --full-delivery Maven smoke runs.`,
      );
    }
  }

  const hostReasons = diagnostics.ARTIFACTORY_HOST.malformedHostReasons;
  if (
    diagnostics.ARTIFACTORY_HOST.present &&
    !diagnostics.ARTIFACTORY_HOST.hostOnly
  ) {
    errors.push(
      `ARTIFACTORY_HOST must be host-only with no protocol, path, /artifactory segment, or whitespace (${hostReasons.join(", ")}).`,
    );
  }

  const settingsChecks = settingsXmlContents.map((settingsXml) =>
    validateMavenSettingsExpansion(settingsXml, env),
  );
  for (const check of settingsChecks) {
    errors.push(...check.errors);
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    diagnostics: {
      ...diagnostics,
      settings: {
        checked: settingsXmlContents.length,
        referencesArtifactoryHost: settingsChecks.some(
          (check) => check.referencesArtifactoryHost,
        ),
      },
    },
    skipped: false,
  };
}
