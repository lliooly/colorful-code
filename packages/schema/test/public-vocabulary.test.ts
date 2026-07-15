import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';

const forbiddenTerms = [
  /\bSession\b/,
  /\bChat\b/,
  /\bsessionId\b/,
  /\bchatId\b/,
  /\bchatMessage\b/,
] as const;

const sourceDirectory = resolve(import.meta.dir, '../src');

const findViolations = (filePath: string, sourceText: string): string[] => {
  const violations: string[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    const candidate =
      ts.isIdentifier(node) || ts.isStringLiteralLike(node)
        ? node.text
        : undefined;

    if (candidate !== undefined) {
      for (const term of forbiddenTerms) {
        if (term.test(candidate)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          violations.push(`${filePath}:${line + 1}: ${term.source}`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
};

describe('public v2 vocabulary', () => {
  test('reports the file and line for forbidden identifiers and literals', () => {
    const sourceText = [
      "export const sessionId = 'value';",
      "export const label = 'Chat';",
    ].join('\n');

    expect(findViolations('legacy.ts', sourceText)).toEqual([
      'legacy.ts:1: \\bsessionId\\b',
      'legacy.ts:2: \\bChat\\b',
    ]);
  });

  test('does not expose legacy Session or Chat domain terms', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan(sourceDirectory)) {
      const absolutePath = resolve(sourceDirectory, relativePath);
      const sourceText = await Bun.file(absolutePath).text();
      violations.push(...findViolations(relativePath, sourceText));
    }

    expect(violations).toEqual([]);
  });
});
