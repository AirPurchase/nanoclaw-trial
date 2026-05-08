/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, retrying with backoff.
 *  Handles macOS wake-from-sleep where Docker takes time to resume. */
export function ensureContainerRuntimeRunning(): void {
  const MAX_RETRIES = 12; // 12 retries × 5s = 60s max wait
  const RETRY_INTERVAL_MS = 5000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      if (attempt > 0) {
        logger.info(
          { attempt },
          'Container runtime became available after retry',
        );
      } else {
        logger.debug('Container runtime already running');
      }
      return;
    } catch {
      if (attempt < MAX_RETRIES) {
        if (attempt === 0) {
          logger.warn(
            'Container runtime not ready, waiting for it to start (macOS wake-from-sleep?)...',
          );
        }
        // Synchronous sleep — acceptable at startup before event loop is active
        execSync(`sleep ${RETRY_INTERVAL_MS / 1000}`, { stdio: 'ignore' });
      }
    }
  }

  // All retries exhausted
  logger.error('Container runtime not available after 60s of retries');
  console.error(
    '\n╔════════════════════════════════════════════════════════════════╗',
  );
  console.error(
    '║  FATAL: Container runtime failed to start                      ║',
  );
  console.error(
    '║                                                                ║',
  );
  console.error(
    '║  Agents cannot run without a container runtime. To fix:        ║',
  );
  console.error(
    '║  1. Ensure Docker is installed and running                     ║',
  );
  console.error(
    '║  2. Run: docker info                                           ║',
  );
  console.error(
    '║  3. Restart NanoClaw                                           ║',
  );
  console.error(
    '╚════════════════════════════════════════════════════════════════╝\n',
  );
  throw new Error('Container runtime is required but failed to start');
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
