import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelClient } from '@colorful-code/tool-runtime';
import type { ModelClientConfig } from './model-config';
import { AnthropicModelClient } from './anthropic-client';
import { OpenAIModelClient } from './openai-client';

// Constructs the concrete SDK client for the chosen protocol and wraps it in the
// matching adapter. This is the only place the real SDKs are instantiated; the
// adapters themselves take structural client interfaces so they remain testable
// without network. The apiKey stays inside the SDK client and never leaves it.
export function createModelClient(config: ModelClientConfig): ModelClient {
  if (config.protocol === 'anthropic') {
    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {})
    });
    return new AnthropicModelClient({
      client,
      model: config.model,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {})
    });
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {})
  });
  return new OpenAIModelClient({
    client,
    model: config.model,
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.temperature !== undefined
      ? { temperature: config.temperature }
      : {})
  });
}
