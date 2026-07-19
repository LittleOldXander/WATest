import { buildApp } from './app/build-app.js';
import { createContainer } from './app/container.js';

/**
 * Process entrypoint: build the dependency graph, start listening, and wire
 * up graceful shutdown. All wiring decisions live in `app/container.ts`.
 */
async function main(): Promise<void> {
  const container = await createContainer();
  const { config, logger, bannerService, metrics, eventBus } = container;

  // Defense in depth: even if ENABLE_TEST_CONTROLS were ever set on a
  // production-mode process, refuse to honour it. Test controls are for
  // local dev and the integration test stack only.
  const enableTestControls = config.enableTestControls && config.nodeEnv !== 'production';
  if (config.enableTestControls && config.nodeEnv === 'production') {
    logger.error(
      { nodeEnv: config.nodeEnv },
      'ENABLE_TEST_CONTROLS=true was set with NODE_ENV=production; ignoring it and keeping test controls disabled',
    );
  }

  const app = buildApp({
    bannerService,
    metrics,
    eventBus,
    // Wrapped rather than passed by reference so `this` stays bound.
    checkReadiness: () => container.checkReadiness(),
    logger: config.logPretty
      ? { level: config.logLevel, transport: { target: 'pino-pretty' } }
      : { level: config.logLevel },
    instanceId: config.instanceId,
    enableTestControls,
    allowTestCacheBust: enableTestControls,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await container.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'Banner delivery service listening');
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    await container.shutdown();
    process.exit(1);
  }
}

void main();
