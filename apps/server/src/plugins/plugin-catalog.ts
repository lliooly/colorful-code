import type { CatalogPlugin } from './plugin-types';

const SKILL_CATALOG: CatalogPlugin[] = [
  {
    kind: 'skill',
    name: 'github:colorful-code/skills/code-review',
    title: 'Code Review Skill',
    description: 'Review code changes with a bug-first engineering stance.',
    version: 'latest',
    config: {
      type: 'skill',
      source: 'github',
      repository: 'colorful-code/skills',
      path: 'code-review',
      entry: 'SKILL.md',
      installHint: 'Install into a configured skill root.',
    },
  },
  {
    kind: 'skill',
    name: 'github:colorful-code/skills/product-planning',
    title: 'Product Planning Skill',
    description: 'Turn rough product ideas into scoped specs and plans.',
    version: 'latest',
    config: {
      type: 'skill',
      source: 'github',
      repository: 'colorful-code/skills',
      path: 'product-planning',
      entry: 'SKILL.md',
      installHint: 'Install into a configured skill root.',
    },
  },
];

const LSP_CATALOG: CatalogPlugin[] = [
  {
    kind: 'lsp',
    name: 'typescript',
    title: 'TypeScript LSP',
    description: 'TypeScript and JavaScript language intelligence.',
    version: 'latest',
    config: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      language: 'typescript',
      fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
  },
  {
    kind: 'lsp',
    name: 'rust',
    title: 'Rust Analyzer',
    description: 'Rust language intelligence through rust-analyzer.',
    version: 'latest',
    config: {
      command: 'rust-analyzer',
      language: 'rust',
      fileExtensions: ['.rs'],
    },
  },
  {
    kind: 'lsp',
    name: 'go',
    title: 'gopls',
    description: 'Go language intelligence through gopls.',
    version: 'latest',
    config: {
      command: 'gopls',
      language: 'go',
      fileExtensions: ['.go'],
    },
  },
  {
    kind: 'lsp',
    name: 'python',
    title: 'Pyright LSP',
    description: 'Python language intelligence through pyright-langserver.',
    version: 'latest',
    config: {
      command: 'pyright-langserver',
      args: ['--stdio'],
      language: 'python',
      fileExtensions: ['.py'],
    },
  },
];

export function listSkillCatalog(): CatalogPlugin[] {
  return [...SKILL_CATALOG];
}

export function listLspCatalog(): CatalogPlugin[] {
  return [...LSP_CATALOG];
}

export function findSkillCatalog(name: string): CatalogPlugin | undefined {
  return SKILL_CATALOG.find((item) => item.name === name);
}

export function findLspCatalog(name: string): CatalogPlugin | undefined {
  return LSP_CATALOG.find((item) => item.name === name);
}
