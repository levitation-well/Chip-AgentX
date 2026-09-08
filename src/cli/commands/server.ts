/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getAuthConfig } from '../../auth/index.js';
import { getDefaultUserChipAccessPath } from '../../chips/index.js';
import { startHttpServer } from '../../http-server.js';
import { outputError } from '../shared.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

/**
 * Register server command - local HTTP/Web control surface
 */
export function registerServer(cli: any) {
  cli.command('server', 'Start the AgentX HTTP/Web server')
    .option('--host <host>', 'Host to bind', { default: DEFAULT_HOST })
    .option('--port <port>', 'Port to listen on', { default: DEFAULT_PORT })
    .option('--public-dir <dir>', 'Directory containing Web UI assets')
    .option('--data-dir <dir>', 'Directory for AgentX persistence data')
    .option('--product-config <file>', 'Product shell configuration file')
    .option('--resource-config <file>', 'Resource visibility catalog configuration file')
    .option('--file-logs', 'Write structured application and audit logs to data/logs')
    .option('--log-retention-days <days>', 'Number of days to retain app/audit log files')
    .option('--no-auth', 'Disable HTTP authentication for local development only')
    .action(async (options: {
      host?: string;
      port?: string | number;
      publicDir?: string;
      dataDir?: string;
      productConfig?: string;
      resourceConfig?: string;
      fileLogs?: boolean;
      logRetentionDays?: string | number;
      auth?: boolean;
    }) => {
      const host = options.host ?? DEFAULT_HOST;
      const port = Number(options.port ?? DEFAULT_PORT);
      const retentionDays =
        options.logRetentionDays === undefined ? undefined : Number(options.logRetentionDays);
      // cac parses `--no-auth` into `options.auth === false` (negated boolean flags keep the
      // base option name, not a `noXxx` field). Only an explicit `false` should disable auth.
      const noAuth = options.auth === false;

      if (!Number.isInteger(port) || port < 0) {
        outputError(`Invalid port: ${String(options.port)}`);
      }
      if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1)) {
        outputError(`Invalid log retention days: ${String(options.logRetentionDays)}`);
      }

      try {
        const rolesFile = path.resolve(process.cwd(), 'config', 'roles.json');
        const dataDir = options.dataDir ?? process.env.AGENTX_DATA_DIR ?? process.env.DATA_DIR;
        const auth = noAuth
          ? { enabled: false as const }
          : {
              enabled: true as const,
              config: { ...getAuthConfig(), ...(dataDir ? { dataDir } : {}) },
              rolesFile
            };

        if (noAuth) {
          console.error(JSON.stringify({ warning: 'Authentication disabled by --no-auth' }, null, 2));
        }

        await startHttpServer({
          host,
          port,
          publicDir: options.publicDir ?? resolveDefaultPublicDir(),
          auth,
          chips: { enabled: true, userAccessFile: getDefaultUserChipAccessPath(dataDir) },
          prompts: { enabled: true, rolesFile },
          resources: {
            enabled: true,
            configFile: options.resourceConfig ?? process.env.AGENTX_RESOURCE_CONFIG_FILE
          },
          product: {
            configFile: options.productConfig ?? process.env.AGENTX_PRODUCT_CONFIG_FILE
          },
          persistence: {
            dataDir,
            fileLogging: options.fileLogs ?? false,
            retentionDays
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputError(`${message}. Configure .env from .env.example or use --no-auth for local development.`);
      }
    });
}

function resolveDefaultPublicDir(): string {
  const fallback = path.resolve(process.cwd(), 'public');
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return fallback;
  }

  try {
    const realEntrypoint = realpathSync(entrypoint);
    const bundledPublicDir = path.resolve(path.dirname(realEntrypoint), '../public');
    if (existsSync(path.join(bundledPublicDir, 'index.html'))) {
      return bundledPublicDir;
    }
  } catch {
    return fallback;
  }

  return fallback;
}
