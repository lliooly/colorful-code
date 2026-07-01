import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import {
  objectSchema,
  optionalField,
  stringField,
  booleanField,
  numberField,
} from '../core/schema.js';
import {
  buildTool,
  type EditProposal,
  type FilePatch,
  type FilePatchHunk,
  type PatchLine,
  type RuntimeContext,
  type Tool,
} from '../core/tool.js';

const DEFAULT_READ_LIMIT_LINES = 200;
const MAX_READ_LIMIT_LINES = 2_000;
const MAX_COMPLETE_READ_BYTES = 1_000_000;

function absolutePath(filePath: string, context: RuntimeContext): string {
  return resolve(context.cwd ?? process.cwd(), filePath);
}

function requireFileState(context: RuntimeContext) {
  if (!context.fileState) {
    context.fileState = new Map();
  }
  return context.fileState;
}

const readInputSchema = objectSchema({
  path: stringField(),
  offset: optionalField(numberField()),
  limit: optionalField(numberField()),
});
const writeInputSchema = objectSchema({
  path: stringField(),
  content: stringField(),
});
const editInputSchema = objectSchema({
  path: stringField(),
  oldText: stringField(),
  newText: stringField(),
  replaceAll: optionalField(booleanField()),
});
const proposalInputSchema = objectSchema({ proposalId: stringField() });

type ReadInput = ReturnType<typeof readInputSchema.parse>;
type WriteInput = ReturnType<typeof writeInputSchema.parse>;
type EditInput = ReturnType<typeof editInputSchema.parse>;
type ProposalInput = ReturnType<typeof proposalInputSchema.parse>;

type ReadOutput = {
  path: string;
  lines: Array<{ number: number; text: string }>;
  startLine: number;
  endLine: number;
  requestedLimit: number;
  effectiveLimit: number;
  truncated: boolean;
};
type WriteOutput = { path: string; bytes: number; patches: FilePatch[] };
type EditOutput = { path: string; replacements: number; patches: FilePatch[] };
type ProposeEditOutput = { proposalId: string; patches: FilePatch[] };
type ApplyEditOutput = { proposalId: string; patches: FilePatch[] };
type RejectEditOutput = { proposalId: string; patches: FilePatch[] };

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer.');
  }
  return value;
}

async function readLinePage(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{
  lines: Array<{ number: number; text: string }>;
  truncated: boolean;
}> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const lines: Array<{ number: number; text: string }> = [];
  let lineNumber = 0;
  let truncated = false;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < offset) {
        continue;
      }
      if (lines.length >= limit) {
        truncated = true;
        break;
      }
      lines.push({ number: lineNumber, text: line });
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { lines, truncated };
}

function formatReadOutput(data: ReadOutput): string {
  const header = [
    'Read ' + data.path,
    'Lines ' + data.startLine + '-' + data.endLine,
  ];
  if (data.requestedLimit !== data.effectiveLimit) {
    header.push(
      'Limit capped at ' +
        data.effectiveLimit +
        ' lines (requested ' +
        data.requestedLimit +
        ').',
    );
  }

  const body = data.lines
    .map((line) => String(line.number) + ' | ' + line.text)
    .join('\n');
  const footer = data.truncated
    ? '\n\n[truncated: more lines available. Use offset: ' +
      (data.endLine + 1) +
      ', limit: ' +
      data.effectiveLimit +
      ' to continue.]'
    : '';

  return header.join('\n') + '\n\n' + body + footer;
}

function linesOf(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function lineNumberOrUndefined(
  index: number,
  total: number,
): number | undefined {
  return index < total ? index + 1 : undefined;
}

function buildPatch(path: string, before: string, after: string): FilePatch {
  const beforeLines = linesOf(before);
  const afterLines = linesOf(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix);
  const contextBeforeStart = Math.max(0, prefix - 3);
  const contextAfterEnd = Math.min(
    beforeLines.length,
    beforeLines.length - suffix + 3,
  );
  const newContextAfterEnd = Math.min(
    afterLines.length,
    afterLines.length - suffix + 3,
  );
  const lines: PatchLine[] = [];

  for (let index = contextBeforeStart; index < prefix; index += 1) {
    lines.push({
      kind: 'context',
      oldNumber: index + 1,
      newNumber: index + 1,
      text: beforeLines[index] ?? '',
    });
  }
  for (let index = 0; index < removedLines.length; index += 1) {
    lines.push({
      kind: 'removed',
      oldNumber: prefix + index + 1,
      text: removedLines[index] ?? '',
    });
  }
  for (let index = 0; index < addedLines.length; index += 1) {
    lines.push({
      kind: 'added',
      newNumber: prefix + index + 1,
      text: addedLines[index] ?? '',
    });
  }
  const contextAfterCount = Math.min(
    contextAfterEnd - (beforeLines.length - suffix),
    newContextAfterEnd - (afterLines.length - suffix),
  );
  for (let index = 0; index < contextAfterCount; index += 1) {
    const oldIndex = beforeLines.length - suffix + index;
    const newIndex = afterLines.length - suffix + index;
    lines.push({
      kind: 'context',
      oldNumber: lineNumberOrUndefined(oldIndex, beforeLines.length),
      newNumber: lineNumberOrUndefined(newIndex, afterLines.length),
      text: beforeLines[oldIndex] ?? afterLines[newIndex] ?? '',
    });
  }

  const oldStart = Math.max(1, contextBeforeStart + 1);
  const newStart = Math.max(1, contextBeforeStart + 1);
  const hunk: FilePatchHunk = {
    oldStart,
    oldLines:
      prefix - contextBeforeStart + removedLines.length + contextAfterCount,
    newStart,
    newLines:
      prefix - contextBeforeStart + addedLines.length + contextAfterCount,
    lines,
  };
  return {
    path,
    status:
      before.length === 0
        ? 'added'
        : after.length === 0
          ? 'deleted'
          : 'modified',
    added: addedLines.length,
    removed: removedLines.length,
    hunks: [hunk],
  };
}

function replaceContent(
  input: EditInput,
  current: string,
): {
  updated: string;
  replacements: number;
} {
  if (input.replaceAll === true) {
    const replacements = current.split(input.oldText).length - 1;
    if (replacements > 0) {
      return {
        updated: current.split(input.oldText).join(input.newText),
        replacements,
      };
    }
    const fuzzy = findWhitespaceNormalizedMatch(current, input.oldText);
    if (!fuzzy) {
      throw new Error('oldText was not found in the current file content.');
    }
    return {
      updated:
        current.slice(0, fuzzy.start) +
        input.newText +
        current.slice(fuzzy.end),
      replacements: 1,
    };
  }

  const index = current.indexOf(input.oldText);
  if (index >= 0) {
    return {
      updated:
        current.slice(0, index) +
        input.newText +
        current.slice(index + input.oldText.length),
      replacements: 1,
    };
  }

  const fuzzy = findWhitespaceNormalizedMatch(current, input.oldText);
  if (!fuzzy) {
    throw new Error('oldText was not found in the current file content.');
  }
  return {
    updated:
      current.slice(0, fuzzy.start) + input.newText + current.slice(fuzzy.end),
    replacements: 1,
  };
}

function normalizeLineWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function lineRanges(
  content: string,
): Array<{ start: number; contentEnd: number; lineEnd: number }> {
  const ranges: Array<{ start: number; contentEnd: number; lineEnd: number }> =
    [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      ranges.push({ start, contentEnd: index, lineEnd: index + 1 });
      start = index + 1;
    }
  }
  if (start < content.length) {
    ranges.push({ start, contentEnd: content.length, lineEnd: content.length });
  }
  return ranges;
}

function findWhitespaceNormalizedMatch(
  current: string,
  oldText: string,
): { start: number; end: number } | undefined {
  const currentLines = linesOf(current);
  const oldLines = linesOf(oldText);
  if (oldLines.length === 0 || oldLines.length > currentLines.length) {
    return undefined;
  }

  const normalizedOld = oldLines.map(normalizeLineWhitespace);
  const normalizedCurrent = currentLines.map(normalizeLineWhitespace);
  const ranges = lineRanges(current);
  const includeTrailingLineBreak = oldText.endsWith('\n');
  for (
    let startLine = 0;
    startLine <= normalizedCurrent.length - normalizedOld.length;
    startLine += 1
  ) {
    let matched = true;
    for (let offset = 0; offset < normalizedOld.length; offset += 1) {
      if (normalizedCurrent[startLine + offset] !== normalizedOld[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const start = ranges[startLine]?.start;
      const lastRange = ranges[startLine + normalizedOld.length - 1];
      const end = includeTrailingLineBreak
        ? lastRange?.lineEnd
        : lastRange?.contentEnd;
      if (start !== undefined && end !== undefined) {
        return { start, end };
      }
    }
  }
  return undefined;
}

function requireProposal(
  context: RuntimeContext,
  proposalId: string,
): EditProposal {
  const proposal = context.editProposals?.get(proposalId);
  if (!proposal) {
    throw new Error('Unknown edit proposal: ' + proposalId);
  }
  return proposal;
}

async function applyProposal(
  proposal: EditProposal,
  context: RuntimeContext,
): Promise<void> {
  for (const file of proposal.files) {
    const current = await readFile(file.path, 'utf8');
    if (file.requireUnchanged && current !== file.before) {
      throw new Error('File changed since the edit was proposed.');
    }
  }
  for (const file of proposal.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.after, 'utf8');
    const stats = await stat(file.path);
    requireFileState(context).set(file.path, {
      content: file.after,
      mtimeMs: stats.mtimeMs,
      complete: true,
    });
  }
}

export async function applyEditProposal(
  proposal: EditProposal,
  context: RuntimeContext,
): Promise<void> {
  await applyProposal(proposal, context);
}

export const ReadTool = buildTool<ReadInput, ReadOutput>({
  name: 'Read',
  aliases: ['FileRead'],
  inputSchema: readInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const offset = positiveInteger(input.offset ?? 1, 'offset');
    const requestedLimit = positiveInteger(
      input.limit ?? DEFAULT_READ_LIMIT_LINES,
      'limit',
    );
    const effectiveLimit = Math.min(requestedLimit, MAX_READ_LIMIT_LINES);
    const stats = await stat(filePath);
    const page = await readLinePage(filePath, offset, effectiveLimit);
    const complete = offset === 1 && !page.truncated;
    const canStoreCompleteSnapshot =
      complete && stats.size <= MAX_COMPLETE_READ_BYTES;
    const snapshotContent = canStoreCompleteSnapshot
      ? await readFile(filePath, 'utf8')
      : '';
    requireFileState(context).set(filePath, {
      content: snapshotContent,
      mtimeMs: stats.mtimeMs,
      complete: canStoreCompleteSnapshot,
    });
    const endLine =
      page.lines.length > 0
        ? page.lines[page.lines.length - 1]!.number
        : offset - 1;
    return {
      data: {
        path: filePath,
        lines: page.lines,
        startLine: offset,
        endLine,
        requestedLimit,
        effectiveLimit,
        truncated: page.truncated || requestedLimit > effectiveLimit,
      },
    };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: formatReadOutput(data) };
  },
});

export const WriteTool = buildTool<WriteInput, WriteOutput>({
  name: 'Write',
  aliases: ['FileWrite'],
  inputSchema: writeInputSchema,
  isDestructive: () => true,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    let before = '';
    try {
      before = await readFile(filePath, 'utf8');
    } catch {
      before = '';
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content, 'utf8');
    const stats = await stat(filePath);
    requireFileState(context).set(filePath, {
      content: input.content,
      mtimeMs: stats.mtimeMs,
      complete: true,
    });
    return {
      data: {
        path: filePath,
        bytes: Buffer.byteLength(input.content),
        patches: [buildPatch(filePath, before, input.content)],
      },
    };
  },
  mapResult(data, toolUseId) {
    return {
      toolUseId,
      content: 'Wrote ' + data.bytes + ' bytes to ' + data.path,
      metadata: { patches: data.patches },
    };
  },
});

export const EditTool = buildTool<EditInput, EditOutput>({
  name: 'Edit',
  aliases: ['FileEdit'],
  inputSchema: editInputSchema,
  isDestructive: () => true,
  validateInput(input, context) {
    if (input.oldText === input.newText) {
      return {
        ok: false,
        message: 'No edit to apply: oldText and newText are identical.',
      };
    }
    const filePath = absolutePath(input.path, context);
    const snapshot = context.fileState?.get(filePath);
    if (snapshot?.stale) {
      return {
        ok: false,
        message: 'File changed since it was read. Read it again before editing.',
      };
    }
    if (!snapshot?.complete) {
      return {
        ok: false,
        message: 'Read before editing: this file has not been read completely.',
      };
    }
    return { ok: true };
  },
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const snapshot = requireFileState(context).get(filePath);
    if (!snapshot?.complete) {
      throw new Error(
        'Read before editing: this file has not been read completely.',
      );
    }

    const current = await readFile(filePath, 'utf8');
    const stats = await stat(filePath);
    if (current !== snapshot.content && stats.mtimeMs >= snapshot.mtimeMs) {
      throw new Error(
        'File changed since it was read. Read it again before editing.',
      );
    }

    const { updated, replacements } = replaceContent(input, current);

    await writeFile(filePath, updated, 'utf8');
    const updatedStats = await stat(filePath);
    requireFileState(context).set(filePath, {
      content: updated,
      mtimeMs: updatedStats.mtimeMs,
      complete: true,
    });
    return {
      data: {
        path: filePath,
        replacements,
        patches: [buildPatch(filePath, current, updated)],
      },
    };
  },
  mapResult(data, toolUseId) {
    return {
      toolUseId,
      content:
        'Edited ' +
        data.path +
        ' (' +
        data.replacements +
        ' replacement' +
        (data.replacements === 1 ? '' : 's') +
        ').',
      metadata: { patches: data.patches },
    };
  },
});

export const ProposeEditTool = buildTool<EditInput, ProposeEditOutput>({
  name: 'ProposeEdit',
  aliases: ['proposeEdit'],
  inputSchema: editInputSchema,
  isDestructive: () => false,
  checkPermissions() {
    return { behavior: 'allow' };
  },
  validateInput: EditTool.validateInput,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const snapshot = requireFileState(context).get(filePath);
    if (!snapshot?.complete) {
      throw new Error(
        'Read before editing: this file has not been read completely.',
      );
    }
    const current = await readFile(filePath, 'utf8');
    const stats = await stat(filePath);
    if (current !== snapshot.content && stats.mtimeMs >= snapshot.mtimeMs) {
      throw new Error(
        'File changed since it was read. Read it again before editing.',
      );
    }
    const { updated } = replaceContent(input, current);
    const patch = buildPatch(filePath, current, updated);
    const proposal = context.proposeEdit
      ? await context.proposeEdit(
          {
            toolUseId: context.toolUseId ?? 'unknown',
            patches: [patch],
            files: [
              {
                path: filePath,
                before: current,
                after: updated,
                mtimeMs: stats.mtimeMs,
                requireUnchanged: true,
              },
            ],
          },
          context,
        )
      : (() => {
          const proposals =
            context.editProposals ?? new Map<string, EditProposal>();
          context.editProposals = proposals;
          const id = 'proposal-' + String(proposals.size + 1);
          const stored: EditProposal = {
            id,
            toolUseId: context.toolUseId ?? 'unknown',
            createdAt: Date.now(),
            patches: [patch],
            files: [
              {
                path: filePath,
                before: current,
                after: updated,
                mtimeMs: stats.mtimeMs,
                requireUnchanged: true,
              },
            ],
            status: 'proposed',
          };
          proposals.set(id, stored);
          return stored;
        })();
    return { data: { proposalId: proposal.id, patches: proposal.patches } };
  },
  mapResult(data, toolUseId) {
    return {
      toolUseId,
      content: 'Proposed edit ' + data.proposalId + '.',
      metadata: { proposalId: data.proposalId, patches: data.patches },
    };
  },
});

export const ApplyEditTool = buildTool<ProposalInput, ApplyEditOutput>({
  name: 'ApplyEdit',
  aliases: ['applyEdit'],
  inputSchema: proposalInputSchema,
  isDestructive: () => true,
  checkPermissions(input, context) {
    const proposal = context.editProposals?.get(input.proposalId);
    if (proposal?.status !== 'approved') {
      return {
        behavior: 'deny',
        message: 'Edit proposal must be approved before it can be applied.',
      };
    }
    return { behavior: 'allow' };
  },
  async call(input, context) {
    const proposal = requireProposal(context, input.proposalId);
    if (proposal.status === 'rejected') {
      throw new Error('Edit proposal was already rejected.');
    }
    if (proposal.status === 'applied') {
      return { data: { proposalId: proposal.id, patches: proposal.patches } };
    }
    if (proposal.status !== 'approved') {
      throw new Error(
        'Edit proposal must be approved before it can be applied.',
      );
    }
    try {
      await (context.applyEditProposal
        ? context.applyEditProposal(proposal, context)
        : applyProposal(proposal, context));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      proposal.status = 'conflict';
      proposal.conflictReason = reason;
      for (const patch of proposal.patches) {
        patch.conflictReason = reason;
      }
      context.conflictEdit?.(proposal, reason, context);
      return {
        data: {
          proposalId: proposal.id,
          patches: proposal.patches,
          reason,
        } as ApplyEditOutput & { reason: string },
      };
    }
    proposal.status = 'applied';
    context.applyEdit?.(proposal, context);
    return { data: { proposalId: proposal.id, patches: proposal.patches } };
  },
  mapResult(data: ApplyEditOutput & { reason?: string }, toolUseId) {
    if (data.reason) {
      return {
        toolUseId,
        content: 'Edit conflict: ' + data.reason,
        isError: true,
        metadata: {
          proposalId: data.proposalId,
          patches: data.patches,
          reason: data.reason,
        },
      };
    }
    return {
      toolUseId,
      content: 'Applied edit ' + data.proposalId + '.',
      metadata: { proposalId: data.proposalId, patches: data.patches },
    };
  },
});

export const RejectEditTool = buildTool<ProposalInput, RejectEditOutput>({
  name: 'RejectEdit',
  aliases: ['rejectEdit'],
  inputSchema: proposalInputSchema,
  isDestructive: () => false,
  checkPermissions() {
    return { behavior: 'allow' };
  },
  async call(input, context) {
    const proposal = requireProposal(context, input.proposalId);
    proposal.status = 'rejected';
    context.rejectEdit?.(proposal, context);
    return { data: { proposalId: proposal.id, patches: proposal.patches } };
  },
  mapResult(data, toolUseId) {
    return {
      toolUseId,
      content: 'Rejected edit ' + data.proposalId + '.',
      metadata: { proposalId: data.proposalId, patches: data.patches },
    };
  },
});

export function createFileTools(): Tool[] {
  return [
    ReadTool,
    WriteTool,
    EditTool,
    ProposeEditTool,
    ApplyEditTool,
    RejectEditTool,
  ];
}
