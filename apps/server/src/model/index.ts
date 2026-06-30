// Real model adapters for the session engine's `ModelClient` boundary. Two
// protocol adapters (Anthropic Messages, OpenAI Chat Completions) plus the preset
// model and the SDK-constructing factory.
export * from './model-config';
export * from './anthropic-client';
export * from './openai-client';
export * from './create-model-client';
