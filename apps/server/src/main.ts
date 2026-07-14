import 'reflect-metadata';
import type { DynamicModule, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import {
  loadServerDevelopmentEnvFiles,
  loadServerEnvironment,
} from './config/environment';
import { buildCorsOptions } from './config/cors';
import type { ServerEnvironment } from './config/environment';
import {
  createDatabaseProvider,
  type DatabaseProvider,
} from './persistence/database-provider';
import { DataDirectoryLockConflictError } from './runtime/data-directory-instance-lock';
import {
  type DaemonApplication,
  type StartDaemonOptions,
  startDaemon,
} from './runtime/daemon-lifecycle';

export interface BootstrapDependencies {
  loadDevelopmentEnvFiles: () => void;
  loadEnvironment: () => ServerEnvironment;
  createNestApplication: (
    environment: ServerEnvironment,
    provider: DatabaseProvider,
  ) => Promise<DaemonApplication>;
  startDaemon: (options: StartDaemonOptions) => Promise<DaemonApplication>;
}

const defaultDependencies: BootstrapDependencies = {
  loadDevelopmentEnvFiles: loadServerDevelopmentEnvFiles,
  loadEnvironment: loadServerEnvironment,
  createNestApplication,
  startDaemon,
};

export async function bootstrap(
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<DaemonApplication> {
  dependencies.loadDevelopmentEnvFiles();
  const serverEnvironment = dependencies.loadEnvironment();

  return dependencies.startDaemon({
    databasePath: serverEnvironment.databasePath,
    createProvider: createDatabaseProvider,
    createApplication: (databasePath, provider) => {
      if (provider === undefined) {
        throw new Error('Daemon did not initialize its DatabaseProvider');
      }
      return dependencies.createNestApplication(
        {
          ...serverEnvironment,
          databasePath,
        },
        provider,
      );
    },
  });
}

export type NestApplicationCreator = (
  module: DynamicModule,
  adapter: FastifyAdapter,
  options: Pick<NestApplicationOptions, 'abortOnError'>,
) => Promise<NestFastifyApplication>;

export async function createNestApplication(
  serverEnvironment: ServerEnvironment,
  provider: DatabaseProvider,
  createApplication: NestApplicationCreator = (module, adapter, options) =>
    NestFactory.create<NestFastifyApplication>(module, adapter, options),
): Promise<DaemonApplication> {
  const adapter = new FastifyAdapter();

  const app = await createApplication(
    AppModule.forRoot(serverEnvironment, provider),
    adapter,
    {
      abortOnError: false,
    },
  );

  app.enableCors(buildCorsOptions(serverEnvironment.corsOrigins));
  app.enableShutdownHooks();

  return {
    listen: async () => {
      await app.listen(serverEnvironment.port, serverEnvironment.host);
    },
    close: () => app.close(),
    onClose: (callback) => {
      adapter.getInstance().addHook('onClose', async () => callback());
    },
  };
}

type ErrorWriter = (...args: unknown[]) => void;
type ProcessState = { exitCode?: string | number | null };

export function reportBootstrapError(
  error: unknown,
  writeError: ErrorWriter = console.error,
  processState: ProcessState = process,
): void {
  if (error instanceof DataDirectoryLockConflictError) {
    writeError(error.message);
  } else {
    writeError(error);
  }
  processState.exitCode = 1;
}

// @ts-expect-error Bun supports import.meta.main; Nest's build target is CommonJS.
if (import.meta.main) {
  void bootstrap().catch((error: unknown) => reportBootstrapError(error));
}
