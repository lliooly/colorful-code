// Model adapter configuration. Two protocols cover the field: Anthropic Messages
// (Claude) and OpenAI Chat Completions (GPT / DeepSeek / any OpenAI-compatible
// endpoint via baseURL). Concrete model offerings are expressed as *presets* over
// these two protocols; `custom` is the general escape hatch.
//
// `apiKey` is a secret: it lives only in this resolved config (built server-side
// per session) and must never be serialized into a SessionSnapshot, a log line,
// or any HTTP response.

export type ModelProtocol = 'anthropic' | 'openai';

export type ModelClientConfig = {
  protocol: ModelProtocol;
  // Provider base URL. Omitted means "use the SDK default" (Anthropic's API host
  // for the anthropic protocol, OpenAI's host for the openai protocol). Presets
  // that target a compatible endpoint (e.g. DeepSeek) set this explicitly.
  baseURL?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  // Anthropic-only. 'adaptive' (the adapter default) enables adaptive thinking;
  // 'disabled' omits it. Ignored by the OpenAI adapter.
  thinking?: 'adaptive' | 'disabled';
};

// A selectable preset. `defaultModel` is the model used when the request does not
// override it; for `openai` it is a sensible starting point, not authoritative —
// callers routinely override it (e.g. a newer GPT id). `custom` carries no
// protocol/baseURL/model of its own: the request must supply them.
export type ModelPreset = {
  id: string;
  label: string;
  protocol?: ModelProtocol;
  baseURL?: string;
  defaultModel?: string;
};

// The built-in presets. `claude` uses the Anthropic SDK default host (no
// baseURL). `deepseek` and `openai` both speak the OpenAI protocol; deepseek
// points at its compatible endpoint, openai uses the SDK default host. `custom`
// defers every choice to the request.
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'claude',
    label: 'Claude',
    protocol: 'anthropic',
    defaultModel: 'claude-opus-4-8'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultModel: 'gpt-4o'
  },
  {
    id: 'custom',
    label: 'Custom'
  }
] as const;

// Per-request overrides layered on top of a preset. Every field is optional; the
// only hard requirements (protocol + model) are enforced after the preset and
// overrides are merged. `apiKey` here is the BYO path for `custom` / self-hosted
// endpoints — for the named presets the key comes from the server environment.
export type ModelSelectionOverrides = {
  protocol?: ModelProtocol;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: 'adaptive' | 'disabled';
};

export const DEFAULT_PRESET_ID = 'claude';

// Resolves a preset id to its definition. Defaults to `claude` when omitted and
// throws on an unknown id so a bad selection fails loudly rather than silently
// downgrading to a default model.
export function resolveModelPreset(presetId?: string): ModelPreset {
  const id = presetId ?? DEFAULT_PRESET_ID;
  const preset = MODEL_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    const known = MODEL_PRESETS.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown model preset: ${id}. Known presets: ${known}.`);
  }
  return preset;
}

// Merges a preset id + overrides + a resolved apiKey into a complete
// ModelClientConfig. The apiKey is passed in (rather than read here) so the
// secret-resolution policy stays in one place (the server's session creation).
// Throws when the protocol or model cannot be determined — the common failure
// for `custom` with missing fields.
export function buildModelClientConfig(args: {
  presetId?: string;
  overrides?: ModelSelectionOverrides;
  apiKey: string;
}): ModelClientConfig {
  const preset = resolveModelPreset(args.presetId);
  const overrides = args.overrides ?? {};

  const protocol = overrides.protocol ?? preset.protocol;
  if (!protocol) {
    throw new Error(
      `Model preset "${preset.id}" has no protocol; supply \`protocol\` ('anthropic' | 'openai').`
    );
  }

  const model = overrides.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(
      `Model preset "${preset.id}" has no default model; supply \`model\`.`
    );
  }

  const baseURL = overrides.baseURL ?? preset.baseURL;

  return {
    protocol,
    ...(baseURL !== undefined ? { baseURL } : {}),
    apiKey: args.apiKey,
    model,
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    ...(overrides.temperature !== undefined
      ? { temperature: overrides.temperature }
      : {}),
    ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {})
  };
}
