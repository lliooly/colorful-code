import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseMarkdown } from '../app/agent/markdown';
import { langFromMarkdownFence } from '../lib/highlighter';

test('parseMarkdown recognizes common assistant markdown blocks', () => {
  const blocks = parseMarkdown(
    [
      '## Summary',
      '',
      'Here is **bold** text and `inline code`.',
      '',
      '- first',
      '- second',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n'),
  );

  assert.deepEqual(blocks, [
    { type: 'heading', level: 2, content: 'Summary' },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Here is ' },
        { type: 'strong', content: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' text and ' },
        { type: 'code', text: 'inline code' },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'list', ordered: false, items: ['first', 'second'] },
    { type: 'code', lang: 'ts', code: 'const value = 1;' },
  ]);
});

test('langFromMarkdownFence normalizes common code fence aliases', () => {
  assert.equal(langFromMarkdownFence('ts'), 'typescript');
  assert.equal(langFromMarkdownFence('.py'), 'python');
  assert.equal(langFromMarkdownFence(''), 'text');
});
