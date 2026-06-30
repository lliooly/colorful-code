export type ParsedSseChunk = {
  events: unknown[];
  remainder: string;
};

export function parseSseChunk(
  previousRemainder: string,
  chunk: string
): ParsedSseChunk {
  const combined = previousRemainder + chunk;
  const frames = combined.split(/\r?\n\r?\n/);
  const remainder = frames.pop() ?? '';
  const events: unknown[] = [];

  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    events.push(JSON.parse(data));
  }

  return { events, remainder };
}
