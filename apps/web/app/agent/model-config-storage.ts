import type { ModelProtocol } from './types';

export const MODEL_CONFIG_STORAGE_KEY = 'colorful-code.agent.model-config';

export type PersistedModelPreferences = {
  presetId: string;
  presetModelOverrides: Record<string, string>;
  customProtocol: ModelProtocol;
  customBaseURL: string;
  customModel: string;
};

export const DEFAULT_MODEL_PREFERENCES: PersistedModelPreferences = {
  presetId: 'claude',
  presetModelOverrides: {},
  customProtocol: 'openai',
  customBaseURL: '',
  customModel: '',
};

export function loadPersistedModelPreferences(
  raw: string | null,
): PersistedModelPreferences {
  if (!raw) return { ...DEFAULT_MODEL_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      presetId: typeof value.presetId === 'string' ? value.presetId : 'claude',
      presetModelOverrides:
        typeof value.presetModelOverrides === 'object' &&
        value.presetModelOverrides !== null &&
        !Array.isArray(value.presetModelOverrides)
          ? (value.presetModelOverrides as Record<string, string>)
          : {},
      customProtocol:
        value.customProtocol === 'anthropic' ? 'anthropic' : 'openai',
      customBaseURL:
        typeof value.customBaseURL === 'string' ? value.customBaseURL : '',
      customModel:
        typeof value.customModel === 'string' ? value.customModel : '',
    };
  } catch {
    return { ...DEFAULT_MODEL_PREFERENCES };
  }
}

export function serializeModelPreferences(
  preferences: PersistedModelPreferences,
): string {
  return JSON.stringify(preferences);
}
