import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bootstrap,
  createNestApplication,
  reportBootstrapError,
  type BootstrapDependencies,
} from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { ConfigModule, SERVER_ENV } from '../src/config/config.module';
import { DataDirectoryLockConflictError } from '../src/runtime/data-directory-instance-lock';
import type { DaemonApplication } from '../src/runtime/daemon-lifecycle';
import type { DatabaseProvider } from '../src/persistence/database-provider';
import {
  DATABASE_PROVIDER,
  DatabaseProviderModule,
} from '../src/persistence/database-provider.module';

const databaseProvider = {} as DatabaseProvider;

const application: DaemonApplication = {
  listen: async () => undefined,
  close: async () => undefined,
  onClose: () => undefined,
};

const serverEnvironment = {
  nodeEnv: 'test' as const,
  isProduction: false,
  host: '127.0.0.9',
  port: 4321,
  corsOrigins: ['http://example.test'],
  providerKeys: {
    anthropic: undefined,
    openai: undefined,
    deepseek: undefined,
  },
  databasePath: '/tmp/colorful-code/main-test.sqlite',
  v2Enabled: true,
};

test('bootstrap delegates application creation exclusively to startDaemon', async () => {
  const events: string[] = [];
  const dependencies: BootstrapDependencies = {
    loadDevelopmentEnvFiles: () => events.push('load-env-files'),
    loadEnvironment: () => serverEnvironment,
    createNestApplication: async (_environment, provider) => {
      assert.equal(provider, databaseProvider);
      events.push('create-nest-app');
      return application;
    },
    startDaemon: async (options) => {
      events.push('start-daemon');
      assert.equal(options.databasePath, '/tmp/colorful-code/main-test.sqlite');
      assert.deepEqual(events, ['load-env-files', 'start-daemon']);
      const created = await options.createApplication(
        '/tmp/colorful-code/resolved-main-test.sqlite',
        databaseProvider,
      );
      assert.equal(created, application);
      return created;
    },
  };

  const result = await bootstrap(dependencies);

  assert.equal(result, application);
  assert.deepEqual(events, [
    'load-env-files',
    'start-daemon',
    'create-nest-app',
  ]);
});

test('bootstrap passes the resolved daemon database path into Nest environment', async () => {
  let receivedEnvironment: typeof serverEnvironment | undefined;
  const dependencies: BootstrapDependencies = {
    loadDevelopmentEnvFiles: () => undefined,
    loadEnvironment: () => serverEnvironment,
    createNestApplication: async (environment, provider) => {
      assert.equal(provider, databaseProvider);
      receivedEnvironment = environment;
      return application;
    },
    startDaemon: async (options) =>
      options.createApplication(
        '/tmp/colorful-code/resolved.sqlite',
        databaseProvider,
      ),
  };

  await bootstrap(dependencies);

  assert.equal(
    receivedEnvironment?.databasePath,
    '/tmp/colorful-code/resolved.sqlite',
  );
  assert.notEqual(receivedEnvironment, serverEnvironment);
});

test('creates Nest with abortOnError disabled so startup cleanup can run', async () => {
  let factoryOptions: unknown;
  let shutdownHookCalls = 0;
  const nestApplication = {
    enableCors: () => undefined,
    enableShutdownHooks: () => {
      shutdownHookCalls += 1;
    },
    listen: async () => undefined,
    close: async () => undefined,
  } as unknown as NestFastifyApplication;

  await createNestApplication(
    serverEnvironment,
    databaseProvider,
    async (_module, _adapter, options) => {
      factoryOptions = options;
      return nestApplication;
    },
  );

  assert.deepEqual(factoryOptions, { abortOnError: false });
  assert.equal(shutdownHookCalls, 1);
});

test('creates Nest from a dynamic AppModule carrying the exact resolved environment', async () => {
  let receivedModule: unknown;
  const nestApplication = {
    enableCors: () => undefined,
    enableShutdownHooks: () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
  } as unknown as NestFastifyApplication;

  await createNestApplication(
    serverEnvironment,
    databaseProvider,
    async (module) => {
      receivedModule = module;
      return nestApplication;
    },
  );

  const appDynamicModule = receivedModule as {
    module?: unknown;
    imports?: Array<{
      module?: unknown;
      providers?: Array<{ provide?: unknown; useValue?: unknown }>;
    }>;
  };
  assert.equal(appDynamicModule.module, AppModule);
  const configDynamicModule = appDynamicModule.imports?.find(
    (entry) => entry.module === ConfigModule,
  );
  const environmentProvider = configDynamicModule?.providers?.find(
    (provider) => provider.provide === SERVER_ENV,
  );
  assert.equal(environmentProvider?.useValue, serverEnvironment);
  const databaseDynamicModule = appDynamicModule.imports?.find(
    (entry) => entry.module === DatabaseProviderModule,
  );
  const databaseProviderBinding = databaseDynamicModule?.providers?.find(
    (provider) => provider.provide === DATABASE_PROVIDER,
  );
  assert.equal(databaseProviderBinding?.useValue, databaseProvider);
});

test('awaits the registered close callback through the Fastify onClose hook', async () => {
  let closeAdapter: (() => Promise<void>) | undefined;
  let callbackStarted = false;
  let finishCallback: () => void = () => undefined;
  const callbackGate = new Promise<void>((resolve) => {
    finishCallback = resolve;
  });
  const nestApplication = {
    enableCors: () => undefined,
    enableShutdownHooks: () => undefined,
    listen: async () => undefined,
    close: async () => closeAdapter?.(),
  } as unknown as NestFastifyApplication;

  const daemonApplication = await createNestApplication(
    serverEnvironment,
    databaseProvider,
    async (_module, adapter) => {
      closeAdapter = () => adapter.close();
      return nestApplication;
    },
  );
  daemonApplication.onClose(async () => {
    callbackStarted = true;
    await callbackGate;
  });

  let closeCompleted = false;
  const closing = daemonApplication.close().then(() => {
    closeCompleted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(callbackStarted, true);
  assert.equal(closeCompleted, false);

  finishCallback();
  await closing;
  assert.equal(closeCompleted, true);
});

test('reports a lock conflict without leaking owner metadata', () => {
  const messages: unknown[][] = [];
  const processState: { exitCode?: number } = {};
  const error = Object.assign(
    new DataDirectoryLockConflictError('/private/data'),
    { ownerPid: 8675309 },
  );

  reportBootstrapError(error, (...args) => messages.push(args), processState);

  assert.deepEqual(messages, [[error.message]]);
  assert.equal(processState.exitCode, 1);
  assert.doesNotMatch(String(messages), /8675309|ownerPid|stack/);
});

test('reports unexpected startup errors and marks the process failed', () => {
  const messages: unknown[][] = [];
  const processState: { exitCode?: number } = {};
  const error = new Error('unexpected');

  reportBootstrapError(error, (...args) => messages.push(args), processState);

  assert.deepEqual(messages, [[error]]);
  assert.equal(processState.exitCode, 1);
});
