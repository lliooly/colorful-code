import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const expectedIds = [
  'P0A-LOCK-001',
  'P0A-MIG-001',
  'P0A-MIG-002',
  'P0A-REC-001',
  'P0A-FIX-001',
  'P0A-PROV-001',
  'P0A-TX-001',
  'P0A-CLOCK-001',
  'P0A-SQL-001',
  'P0A-BUSY-001',
  'P0A-CLOSE-001',
  'P0A-V2-001',
  'P0A-COMPAT-001',
] as const;

type ManifestEntry = {
  id: string;
  requirement: string;
  evidence: Array<{ file: string; test: string }>;
};

function staticTopLevelTestNames(source: string, file: string): Set<string> {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!ts.isCallExpression(expression)) continue;
    if (!ts.isIdentifier(expression.expression)) continue;
    if (expression.expression.text !== 'test') continue;
    const name = expression.arguments[0];
    if (name && ts.isStringLiteral(name)) names.add(name.text);
  }
  return names;
}

test('Phase 0A invariant manifest references complete static test evidence', async () => {
  const manifest = JSON.parse(
    await readFile(join(import.meta.dir, 'phase-0a-invariants.json'), 'utf8'),
  ) as ManifestEntry[];
  assert.deepEqual(
    [...manifest.map(({ id }) => id)].sort(),
    [...expectedIds].sort(),
  );
  assert.equal(new Set(manifest.map(({ id }) => id)).size, manifest.length);

  for (const { id, requirement, evidence } of manifest) {
    assert.match(requirement, /\S.{20,}/, `${id} has no concrete requirement`);
    assert.ok(evidence.length > 0, `${id} has no evidence`);
    for (const item of evidence) {
      assert.equal(
        basename(item.file),
        item.file,
        `${id} escapes test directory`,
      );
      const path = join(import.meta.dir, item.file);
      const names = staticTopLevelTestNames(await readFile(path, 'utf8'), path);
      assert.ok(
        names.has(item.test),
        `${id} references missing test: ${item.test}`,
      );
    }
  }
});
