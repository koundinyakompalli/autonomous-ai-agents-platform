import {
  initSpecFactoryTelemetry,
  shutdownSpecFactoryTelemetry,
} from "./telemetry/init.js";

const port = Number(process.env.SPEC_FACTORY_PORT || 3012);
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const role = process.env.SPEC_FACTORY_MODE?.trim() || "all-local";
  initSpecFactoryTelemetry(role);
  const [database, serverModule] = await Promise.all([
    import("../orchestrator/database.js"),
    import("./server.js"),
  ]);
  await database.initDatabase();
  await serverModule.assertSpecFactoryLegacyRemovalDatabaseGates(
    database.getDatabase().getPool(),
  );
  const app = serverModule.buildSpecFactoryApp();

  const server = app.listen(port, () => {
    console.log(`Spec Factory HTTP service listening on port ${port}`);
  });
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Spec Factory received ${signal}; shutting down`);
    let exitCode = 0;
    const forceCloseTimer = setTimeout(
      () => server.closeAllConnections(),
      SHUTDOWN_GRACE_MS,
    );
    forceCloseTimer.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    } catch (error) {
      exitCode = 1;
      console.error("Spec Factory HTTP shutdown failed", error);
    } finally {
      clearTimeout(forceCloseTimer);
      await shutdownSpecFactoryTelemetry();
      process.exit(exitCode);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (error) => {
  console.error("Spec Factory HTTP service failed to start", error);
  await shutdownSpecFactoryTelemetry();
  process.exit(1);
});
