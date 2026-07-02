import { Inject, Injectable } from '@nestjs/common';
import type { ModelClient } from '@colorful-code/tool-runtime';
import { SERVER_ENV } from '../config/config.module';
import type { ServerEnvironment } from '../config/environment';
import {
  MODEL_PRESETS,
  type ModelClientConfig,
  type ModelProtocol,
} from './model-config';
import { createModelClient } from './create-model-client';
import {
  resolveModelClientConfig,
  type ModelSelection,
} from '../sessions/model-factory';

export type PublicModelPreset = {
  id: string;
  label: string;
  protocol?: ModelProtocol;
  baseURL?: string;
  defaultModel?: string;
  requiresApiKey: true;
  requiresBaseURL: boolean;
  requiresModel: boolean;
};

export type ModelConnectionResult = {
  ok: true;
  protocol: ModelProtocol;
  model: string;
  sample?: string;
};

export function publicModelPresets(): PublicModelPreset[] {
  return MODEL_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    ...(preset.protocol !== undefined ? { protocol: preset.protocol } : {}),
    ...(preset.baseURL !== undefined ? { baseURL: preset.baseURL } : {}),
    ...(preset.defaultModel !== undefined
      ? { defaultModel: preset.defaultModel }
      : {}),
    requiresApiKey: true,
    requiresBaseURL: preset.id === 'custom',
    requiresModel: preset.id === 'custom',
  }));
}

export async function probeModelConnection(
  config: ModelClientConfig,
  createClient: (config: ModelClientConfig) => ModelClient = createModelClient,
): Promise<ModelConnectionResult> {
  const client = createClient(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    let sample = '';
    for await (const event of client.run({
      history: [{ role: 'user', content: 'Reply with OK only.' }],
      tools: [],
      signal: controller.signal,
      system: 'You are testing whether the configured model responds.',
    })) {
      if (event.type === 'text') {
        sample += event.text;
      }
      if (event.type === 'end' || sample.trim().length > 0) {
        break;
      }
    }

    return {
      ok: true,
      protocol: config.protocol,
      model: config.model,
      ...(sample.trim().length > 0
        ? { sample: sample.trim().slice(0, 160) }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listOpenAICompatibleModels(
  config: ModelClientConfig,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (config.protocol !== 'openai') {
    throw new Error(
      'Model listing is only available for OpenAI-compatible adapters.',
    );
  }

  const baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  );
  const response = await fetcher(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Model list request failed: ${String(response.status)} ${
        response.statusText
      }${detail ? ` — ${detail}` : ''}`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('Model list response did not include a data array.');
  }

  return (payload as { data: unknown[] }).data
    .map((item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : null,
    )
    .filter((id): id is string => id !== null);
}

@Injectable()
export class ModelsService {
  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnvironment) {}

  presets(): { presets: PublicModelPreset[] } {
    return { presets: publicModelPresets() };
  }

  async test(selection: ModelSelection): Promise<ModelConnectionResult> {
    const config = resolveModelClientConfig(this.env, selection);
    return await probeModelConnection(config);
  }

  async list(selection: ModelSelection): Promise<{ models: string[] }> {
    const config = resolveModelClientConfig(this.env, selection);
    return { models: await listOpenAICompatibleModels(config) };
  }
}
