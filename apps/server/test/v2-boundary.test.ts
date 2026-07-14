import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createV2Boundary } from '../src/v2/v2-boundary';
import { loadServerEnvironment } from '../src/config/environment';
import { audit } from '../src/persistence/schema';
import {
  createTestDatabase,
  withRawTestConnection,
} from './support/test-database-factory';

test('2.0 boundary is disabled by default and owns no persistence', () => {
  assert.equal(loadServerEnvironment({ NODE_ENV: 'test' }).v2Enabled, false);
  assert.equal(
    loadServerEnvironment({
      NODE_ENV: 'test',
      COLORFUL_CODE_V2_ENABLED: 'true',
    }).v2Enabled,
    true,
  );
  assert.deepEqual(createV2Boundary(true), {
    enabled: true,
    persistenceOwner: 'none',
  });
  const source = readFileSync(
    new URL('../src/v2/v2-boundary.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /SessionStore|persistence\/session-store/);
});

test('2.0 flag rejects ambiguous values', () => {
  assert.throws(
    () =>
      loadServerEnvironment({
        NODE_ENV: 'test',
        COLORFUL_CODE_V2_ENABLED: 'yes',
      }),
    /COLORFUL_CODE_V2_ENABLED must be true or false/,
  );
});

test('feature flag off completes a database lifecycle without 2.0 schema or business writes', async () => {
  const environment = loadServerEnvironment({
    NODE_ENV: 'test',
    COLORFUL_CODE_V2_ENABLED: 'false',
  });
  const boundary = createV2Boundary(environment.v2Enabled);
  const database = await createTestDatabase({ kind: 'legacy-1x' });
  const schemaObjects = () =>
    withRawTestConnection(database, 'read-only', (connection) =>
      connection
        .query<{ name: string }, []>(
          `SELECT name
             FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name`,
        )
        .all()
        .map(({ name }) => name),
    );

  try {
    assert.deepEqual(boundary, { enabled: false, persistenceOwner: 'none' });
    const schemaBefore = schemaObjects();
    const auditCountBefore = database.provider.read(
      (connection) => connection.db.select().from(audit).all().length,
    );

    // A representative 1.x write still flows through the only persistence
    // owner. The disabled boundary has no callback or repository through which
    // it could dual-write 2.0 state.
    await database.provider.transaction(({ database: connection, now }) => {
      connection.db
        .insert(audit)
        .values({
          sessionId: 'legacy-session-1',
          toolUseId: 'v2-disabled-gate',
          toolName: 'Gate',
          behavior: 'allow',
          reason: null,
          at: now,
        })
        .run();
    });

    assert.deepEqual(schemaObjects(), schemaBefore);
    assert.equal(
      database.provider.read(
        (connection) => connection.db.select().from(audit).all().length,
      ),
      auditCountBefore + 1,
    );
    assert.equal(
      schemaBefore.some((name) =>
        /^(threads?|inputs?|operations?|ledger|outbox)$/i.test(name),
      ),
      false,
    );
  } finally {
    await database.close();
  }
});
