export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; content: MarkdownInline[] }
  | { type: 'emphasis'; content: MarkdownInline[] }
  | { type: 'link'; content: MarkdownInline[]; href: string };

export type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MarkdownBlock =
  | { type: 'heading'; level: MarkdownHeadingLevel; content: string }
  | { type: 'paragraph'; content: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; code: string };

const fencePattern = /^```([^\s`]*)\s*$/;
const headingPattern = /^(#{1,6})\s+(.+)$/;
const unorderedListPattern = /^[-*]\s+(.+)$/;
const orderedListPattern = /^\d+[.)]\s+(.+)$/;

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = line.match(fencePattern);
    if (fence) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !fencePattern.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as MarkdownHeadingLevel,
        content: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const unorderedItem = line.match(unorderedListPattern);
    const orderedItem = line.match(orderedListPattern);
    if (unorderedItem || orderedItem) {
      const ordered = Boolean(orderedItem);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered
          ? current.match(orderedListPattern)
          : current.match(unorderedListPattern);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '') break;
      if (
        fencePattern.test(current) ||
        headingPattern.test(current) ||
        unorderedListPattern.test(current) ||
        orderedListPattern.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      content: parseInlineMarkdown(paragraphLines.join('\n')),
    });
  }

  return blocks;
}

function parseInlineMarkdown(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let index = 0;

  while (index < text.length) {
    const codeStart = text.indexOf('`', index);
    const strongStart = text.indexOf('**', index);
    const linkStart = text.indexOf('[', index);
    const emphasisStart = findSingleAsterisk(text, index);
    const next = smallestNonNegative([
      codeStart,
      strongStart,
      linkStart,
      emphasisStart,
    ]);

    if (next === -1) {
      pushText(nodes, text.slice(index));
      break;
    }

    if (next > index) pushText(nodes, text.slice(index, next));

    if (next === codeStart) {
      const end = text.indexOf('`', next + 1);
      if (end === -1) {
        pushText(nodes, text.slice(next));
        break;
      }
      nodes.push({ type: 'code', text: text.slice(next + 1, end) });
      index = end + 1;
      continue;
    }

    if (next === strongStart) {
      const end = text.indexOf('**', next + 2);
      if (end === -1) {
        pushText(nodes, text.slice(next));
        break;
      }
      nodes.push({
        type: 'strong',
        content: parseInlineMarkdown(text.slice(next + 2, end)),
      });
      index = end + 2;
      continue;
    }

    if (next === linkStart) {
      const closeLabel = text.indexOf(']', next + 1);
      const openHref = closeLabel === -1 ? -1 : text.indexOf('(', closeLabel);
      const closeHref = openHref === -1 ? -1 : text.indexOf(')', openHref);
      if (
        closeLabel === -1 ||
        openHref !== closeLabel + 1 ||
        closeHref === -1
      ) {
        pushText(nodes, text.slice(next, next + 1));
        index = next + 1;
        continue;
      }
      nodes.push({
        type: 'link',
        content: parseInlineMarkdown(text.slice(next + 1, closeLabel)),
        href: text.slice(openHref + 1, closeHref),
      });
      index = closeHref + 1;
      continue;
    }

    const end = findSingleAsterisk(text, next + 1);
    if (end === -1) {
      pushText(nodes, text.slice(next));
      break;
    }
    nodes.push({
      type: 'emphasis',
      content: parseInlineMarkdown(text.slice(next + 1, end)),
    });
    index = end + 1;
  }

  return nodes;
}

function pushText(nodes: MarkdownInline[], text: string): void {
  if (text.length === 0) return;
  const previous = nodes.at(-1);
  if (previous?.type === 'text') {
    previous.text += text;
    return;
  }
  nodes.push({ type: 'text', text });
}

function smallestNonNegative(values: number[]): number {
  return values.reduce((smallest, value) => {
    if (value < 0) return smallest;
    if (smallest < 0) return value;
    return Math.min(smallest, value);
  }, -1);
}

function findSingleAsterisk(text: string, start: number): number {
  let index = text.indexOf('*', start);
  while (index !== -1) {
    if (text[index - 1] !== '*' && text[index + 1] !== '*') return index;
    index = text.indexOf('*', index + 1);
  }
  return -1;
}
