import {
  createScriptedModelClient,
  type ModelClient
} from '@colorful-code/tool-runtime';

// Injection token for the per-session model client factory. A new `ModelClient`
// is built for every session so model configuration can stay per-session
// (request-supplied or a server default). Step 2 replaces the default
// implementation with the real Anthropic / OpenAI protocol adapters; tests
// override this provider with their own scripted client so request bodies never
// carry test scripts.
export const MODEL_CLIENT_FACTORY = 'MODEL_CLIENT_FACTORY';

// Options forwarded to the factory when a session is created. Intentionally
// minimal for now — real adapters (Step 2) extend this with protocol/baseURL/
// model/apiKey. Secrets must never be logged or echoed back to the client.
export type ModelClientFactoryOptions = {
  sessionId: string;
};

export type ModelClientFactory = (
  options: ModelClientFactoryOptions
) => ModelClient;

// PLACEHOLDER default factory. The real model adapters do not exist yet
// (Step 2), so the server ships with a scripted mock that produces a single
// final text completion and never requests a tool. It is obviously a stand-in:
// it ignores conversation history and always answers the same way. Anything
// that needs real model behaviour must override MODEL_CLIENT_FACTORY (the e2e
// does exactly this).
export const createPlaceholderModelClientFactory =
  (): ModelClientFactory =>
  (): ModelClient =>
    createScriptedModelClient([
      [
        {
          type: 'text',
          text: 'Placeholder model client: configure a real model adapter (Step 2) to get real completions.'
        }
      ]
    ]);
