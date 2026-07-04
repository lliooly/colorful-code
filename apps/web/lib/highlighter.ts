import {
  getSingletonHighlighter,
  type BundledLanguage,
  type ThemedToken,
} from 'shiki/bundle/web';

let initPromise: Promise<void> | null = null;
let highlighter: Awaited<ReturnType<typeof getSingletonHighlighter>> | null =
  null;

async function ensureHighlighter() {
  if (highlighter) return;
  if (!initPromise) {
    initPromise = getSingletonHighlighter({
      themes: ['dark-plus', 'light-plus'],
      langs: [
        'typescript',
        'tsx',
        'javascript',
        'jsx',
        'json',
        'css',
        'html',
        'python',
        'bash',
        'markdown',
        'yaml',
        'sql',
        'java',
        'xml',
        'vue',
        'svelte',
      ],
    }).then((h: typeof highlighter) => {
      highlighter = h;
    });
  }
  return initPromise;
}

const extToLang: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  md: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  java: 'java',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
};

export function langFromPath(path: string): string {
  const parts = path.split('.');
  if (parts.length >= 3 && parts.at(-2) === 'd') {
    return 'typescript';
  }
  const ext = parts.pop()?.toLowerCase() ?? '';
  return extToLang[ext] || 'text';
}

export function langFromMarkdownFence(info: string): string {
  const normalized = info.trim().toLowerCase().replace(/^\./, '');
  if (normalized.length === 0) return 'text';
  return extToLang[normalized] || normalized;
}

export interface TokenizedLine {
  tokens: ThemedToken[];
  text: string;
}

export async function tokenizeCode(
  code: string,
  lang: string,
  isDark: boolean,
): Promise<TokenizedLine[]> {
  if (lang === 'text') {
    return code.split('\n').map((line) => ({
      tokens: [],
      text: line,
    }));
  }
  await ensureHighlighter();
  if (!highlighter) return [];

  try {
    const result = await highlighter.codeToTokens(code, {
      lang: lang as BundledLanguage,
      theme: isDark ? 'dark-plus' : 'light-plus',
    });
    return result.tokens.map((lineTokens: ThemedToken[]) => {
      const text = lineTokens.map((t: ThemedToken) => t.content).join('');
      return { tokens: lineTokens, text };
    });
  } catch {
    return code.split('\n').map((line) => ({
      tokens: [],
      text: line,
    }));
  }
}
