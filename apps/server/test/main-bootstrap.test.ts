import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bootstrap,
  createNestApplication,
  reportBootstrapError,
  type BootstrapDependencies,
} from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataDirectoryLockConflictError } from '../src/runtime/data-directory-instance-lock';
import type { DaemonApplication } from '../src/runtime/daemon-lifecycle';

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
    createNestApplication: async () => {
      events.push('create-nest-app');
      return application;
    },
    startDaemon: async (options) => {
      events.push('start-daemon');
      assert.equal(options.databasePath, '/tmp/colorful-code/main-test.sqlite');
      assert.deepEqual(events, ['load-env-files', 'start-daemon']);
      const created = await options.createApplication();
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
    async (_module, _adapter, options) => {
      factoryOptions = options;
      return nestApplication;
    },
  );

  assert.deepEqual(factoryOptions, { abortOnError: false });
  assert.equal(shutdownHookCalls, 1);
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
