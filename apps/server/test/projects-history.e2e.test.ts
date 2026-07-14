import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type SessionSnapshot,
} from '@colorful-code/tool-runtime';
import { ProjectsController } from '../src/sessions/projects.controller';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory,
} from '../src/sessions/model-factory';
import { SessionStore } from '../src/persistence/session-store';
import {
  closeTestSessionStores,
  createTestSessionStore,
} from './support/test-session-store';

const scriptedFactory: ModelClientFactory = (): ModelClient =>
  createScriptedModelClient([[{ type: 'text', text: 'ok' }]]);

@Module({
  controllers: [ProjectsController, SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    {
      provide: SessionStore,
      useFactory: () => createTestSessionStore(),
    },
  ],
})
class TestAppModule {}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await closeTestSessionStores();
});

async function boot(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

async function postJson(
  fastify: NestFastifyApplication['getHttpAdapter'] extends () => infer A
    ? A extends { getInstance(): infer F }
      ? F
      : never
    : never,
  url: string,
  payload: unknown,
) {
  return fastify.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('project import is idempotent and project sessions use the project path', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const projectDir = mkdtempSync(join(tmpdir(), 'colorful-project-'));
  try {
    const first = await postJson(fastify, '/projects', { path: projectDir });
    const second = await postJson(fastify, '/projects', {
      path: projectDir + '/',
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const project = first.json();
    assert.equal(second.json().id, project.id);

    const created = await postJson(fastify, '/sessions', {
      projectId: project.id,
    });
    assert.equal(created.statusCode, 201);

    const snapshot = app.get(SessionsService).has(created.json().id);
    assert.equal(snapshot, true);

    const sessionSnapshot = app
      .get(SessionsService)
      .getLiveSnapshot(created.json().id);
    assert.equal(sessionSnapshot?.cwd, projectDir);
    assert.deepEqual(sessionSnapshot?.workspaceRoots, [projectDir]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('GET /sessions groups project chats separately from standalone chats and pins first', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const projectDir = mkdtempSync(join(tmpdir(), 'colorful-project-'));
  try {
    const project = (
      await postJson(fastify, '/projects', { path: projectDir })
    ).json();
    const standalone = (await postJson(fastify, '/sessions', {})).json();
    const projectChat = (
      await postJson(fastify, '/sessions', { projectId: project.id })
    ).json();

    await fastify.inject({
      method: 'PATCH',
      url: `/sessions/${projectChat.id}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pinned: true }),
    });

    const response = await fastify.inject({ method: 'GET', url: '/sessions' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();

    assert.deepEqual(
      body.chats.map((chat: { id: string }) => chat.id),
      [standalone.id],
    );
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, project.id);
    assert.deepEqual(
      body.projects[0].chats.map((chat: { id: string; pinned: boolean }) => [
        chat.id,
        chat.pinned,
      ]),
      [[projectChat.id, true]],
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('legacy cwd sessions can move under a project imported after history was listed', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const store = app.get(SessionStore);
  const projectDir = mkdtempSync(join(tmpdir(), 'colorful-project-'));
  try {
    const legacySnapshot: SessionSnapshot = {
      id: 'legacy-session',
      cwd: projectDir,
      history: [{ role: 'user', content: 'legacy work' }],
      permissionMode: 'default',
      workspaceRoots: [projectDir],
      todos: [],
    };
    store.saveSnapshot(legacySnapshot);

    const beforeImport = await fastify.inject({
      method: 'GET',
      url: '/sessions',
    });
    assert.equal(beforeImport.statusCode, 200);
    assert.deepEqual(
      beforeImport.json().chats.map((chat: { id: string }) => chat.id),
      ['legacy-session'],
    );
    assert.equal(
      store.loadSessionMetadata('legacy-session'),
      undefined,
      'unmatched legacy sessions are not stamped standalone',
    );

    const project = (
      await postJson(fastify, '/projects', { path: projectDir })
    ).json();
    const afterImport = await fastify.inject({
      method: 'GET',
      url: '/sessions',
    });
    assert.equal(afterImport.statusCode, 200);
    assert.deepEqual(afterImport.json().chats, []);
    assert.deepEqual(
      afterImport
        .json()
        .projects[0].chats.map((chat: { id: string }) => chat.id),
      ['legacy-session'],
    );
    assert.equal(
      store.loadSessionMetadata('legacy-session')?.projectId,
      project.id,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('DELETE /sessions scopes hard deletes by standalone and project', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const projectDir = mkdtempSync(join(tmpdir(), 'colorful-project-'));
  try {
    const project = (
      await postJson(fastify, '/projects', { path: projectDir })
    ).json();
    const standalone = (await postJson(fastify, '/sessions', {})).json();
    const projectChat = (
      await postJson(fastify, '/sessions', { projectId: project.id })
    ).json();

    const standaloneDelete = await fastify.inject({
      method: 'DELETE',
      url: '/sessions?scope=standalone',
    });
    assert.equal(standaloneDelete.statusCode, 204, standaloneDelete.body);
    assert.equal(
      app.get(SessionsService).loadSnapshot(standalone.id),
      undefined,
    );
    assert.notEqual(
      app.get(SessionsService).getLiveSnapshot(projectChat.id),
      undefined,
    );

    const projectDelete = await fastify.inject({
      method: 'DELETE',
      url: `/sessions?projectId=${encodeURIComponent(project.id)}`,
    });
    assert.equal(projectDelete.statusCode, 204);
    assert.equal(
      app.get(SessionsService).loadSnapshot(projectChat.id),
      undefined,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('DELETE /projects/:id hard-deletes the project and all of its chats', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const projectDir = mkdtempSync(join(tmpdir(), 'colorful-project-'));
  try {
    const project = (
      await postJson(fastify, '/projects', { path: projectDir })
    ).json();
    const standalone = (await postJson(fastify, '/sessions', {})).json();
    const projectChat = (
      await postJson(fastify, '/sessions', { projectId: project.id })
    ).json();

    const response = await fastify.inject({
      method: 'DELETE',
      url: `/projects/${encodeURIComponent(project.id)}`,
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(
      app.get(SessionsService).getLiveSnapshot(projectChat.id),
      undefined,
    );

    const history = await fastify.inject({ method: 'GET', url: '/sessions' });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json().projects, []);
    assert.deepEqual(
      history.json().chats.map((chat: { id: string }) => chat.id),
      [standalone.id],
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
