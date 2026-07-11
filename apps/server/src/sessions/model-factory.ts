import {
  createScriptedModelClient,
  type ModelClient,
} from '@colorful-code/tool-runtime';
import type { ServerEnvironment } from '../config/environment';
import {
  buildModelClientConfig,
  resolveModelPreset,
  type ModelClientConfig,
  type ModelSelectionOverrides,
} from '../model/model-config';
import { createModelClient } from '../model/create-model-client';

// Injection token for the per-session model client factory. A new `ModelClient`
// is built for every session so model configuration stays per-session
// (request-supplied selection or the server default fallback). Tests override
// this provider with their own scripted client so request bodies never carry
// test scripts.
export const MODEL_CLIENT_FACTORY = 'MODEL_CLIENT_FACTORY';

// A validated per-request model selection (see the controller for the wire shape
// and validation). `preset` chooses a MODEL_PRESETS entry; the remaining fields
// override the preset. `apiKey` is the BYO path (custom / self-hosted endpoints);
// for the named presets the key is resolved server-side from the environment and
// the request `apiKey` is ignored.
export type ModelSelection = {
  preset?: string;
} & ModelSelectionOverrides;

// Options forwarded to the factory when a session is created. `selection` is the
// optional per-request model choice; absent means "use the server default".
// Secrets must never be logged or echoed back to the client.
export type ModelClientFactoryOptions = {
  sessionId: string;
  selection?: ModelSelection;
};

export type ModelClientFactory = (
  options: ModelClientFactoryOptions,
) => ModelClient;

// Thrown when a model selection cannot be satisfied (no provider key, or an
// incomplete custom selection). The controller maps this to a 400 so the failure
// is reported at `POST /sessions` rather than mid-turn. The message is safe to
// surface — it never contains a key.
export class ModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}

// Picks the provider API key for a resolved config. A request-scoped apiKey wins
// for every preset, which lets the desktop UI test and run named templates
// without requiring server env changes. If absent, named presets read the key
// from the environment by protocol/preset; `custom` requires a per-request BYO
// key. Throws ModelSelectionError when the needed key is absent.
function resolveApiKey(
  env: ServerEnvironment,
  presetId: string | undefined,
  selection: ModelSelection,
): { value: string; source: 'request' | 'server' } {
  const preset = resolveModelPreset(presetId);

  if (selection.apiKey && selection.apiKey.length > 0) {
    return { value: selection.apiKey, source: 'request' };
  }

  // Custom (or any selection without a named-preset key source) must bring its
  // own key.
  if (preset.id === 'custom') {
    throw new ModelSelectionError(
      'The custom model preset requires an `apiKey` in the request (bring your own key).',
    );
  }

  const keyByPreset: Record<string, string | undefined> = {
    claude: env.providerKeys.anthropic,
    deepseek: env.providerKeys.deepseek,
    openai: env.providerKeys.openai,
  };

  const key = keyByPreset[preset.id];
  if (key && key.length > 0) {
    return { value: key, source: 'server' };
  }

  throw new ModelSelectionError(
    `No API key configured for the "${preset.id}" model preset. Set the corresponding provider key on the server, or use the custom preset with a request \`apiKey\`.`,
  );
}

// Resolves a per-request selection (or the default) into a complete, secret-
// bearing ModelClientConfig. Exposed for the controller's pre-flight validation
// (so a missing key fails at create time) and reused by the real factory.
export function resolveModelClientConfig(
  env: ServerEnvironment,
  selection: ModelSelection = {},
): ModelClientConfig {
  const { preset, ...overrides } = selection;
  const resolvedKey = resolveApiKey(env, preset, selection);
  const resolvedPreset = resolveModelPreset(preset);
  if (
    resolvedKey.source === 'server' &&
    resolvedPreset.id !== 'custom' &&
    (selection.baseURL !== undefined || selection.protocol !== undefined)
  ) {
    throw new ModelSelectionError(
      'Named presets using server credentials do not allow protocol or endpoint override.',
    );
  }
  try {
    return buildModelClientConfig({
      ...(preset !== undefined ? { presetId: preset } : {}),
      overrides,
      apiKey: resolvedKey.value,
    });
  } catch (error) {
    // buildModelClientConfig throws plain Errors for unknown preset / missing
    // protocol or model; normalize them to ModelSelectionError -> 400.
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelSelectionError(message);
  }
}

// The production factory: builds a real Anthropic / OpenAI adapter per session
// from the resolved config. The apiKey lives only inside the constructed SDK
// client; it is never stored on the session, logged, or returned.
export const createServerModelClientFactory =
  (env: ServerEnvironment): ModelClientFactory =>
  (options: ModelClientFactoryOptions): ModelClient =>
    createModelClient(resolveModelClientConfig(env, options.selection));

// PLACEHOLDER factory retained for environments without provider keys and for
// reference. It produces a single final text completion and never requests a
// tool — obviously a stand-in. Anything that needs real model behaviour uses the
// server factory above (default) or overrides MODEL_CLIENT_FACTORY (the e2e).
export const createPlaceholderModelClientFactory =
  (): ModelClientFactory => (): ModelClient =>
    createScriptedModelClient([
      [
        {
          type: 'text',
          text: 'Placeholder model client: configure a real model adapter (Step 2) to get real completions.',
        },
      ],
    ]);
