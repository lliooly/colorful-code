import { PERMISSION_MODES, type PermissionMode } from './types';

export type Language = 'en' | 'zh';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ModelPresetId = 'claude' | 'deepseek' | 'openai' | 'custom';

export const MODEL_PRESET_IDS: readonly ModelPresetId[] = [
  'claude',
  'deepseek',
  'openai',
  'custom',
];

export type AgentPreferences = {
  language: Language;
  theme: ThemePreference;
  permissionModeVisibility: Record<PermissionMode, boolean>;
  modelPresetVisibility: Record<ModelPresetId, boolean>;
};

export const AGENT_PREFERENCES_STORAGE_KEY = 'colorful-code.agent.preferences';

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  language: 'en',
  theme: 'system',
  permissionModeVisibility: {
    default: true,
    plan: true,
    acceptEdits: true,
    readOnly: true,
    bypass: true,
  },
  modelPresetVisibility: {
    claude: true,
    deepseek: true,
    openai: true,
    custom: true,
  },
};

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh';
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function mergeAgentPreferences(value: unknown): AgentPreferences {
  if (!isRecord(value)) return DEFAULT_AGENT_PREFERENCES;

  return {
    language: isLanguage(value.language)
      ? value.language
      : DEFAULT_AGENT_PREFERENCES.language,
    theme: isThemePreference(value.theme)
      ? value.theme
      : DEFAULT_AGENT_PREFERENCES.theme,
    permissionModeVisibility: mergePermissionVisibility(
      value.permissionModeVisibility,
    ),
    modelPresetVisibility: mergeModelPresetVisibility(
      value.modelPresetVisibility,
    ),
  };
}

export function setPermissionModeVisibility(
  preferences: AgentPreferences,
  mode: PermissionMode,
  visible: boolean,
): AgentPreferences {
  return {
    ...preferences,
    permissionModeVisibility: {
      ...preferences.permissionModeVisibility,
      [mode]: visible,
    },
  };
}

export function getVisiblePermissionModes(
  preferences: AgentPreferences,
): PermissionMode[] {
  return PERMISSION_MODES.filter(
    (mode) => preferences.permissionModeVisibility[mode],
  );
}

export function setModelPresetVisibility(
  preferences: AgentPreferences,
  presetId: string,
  visible: boolean,
): AgentPreferences {
  if (!isModelPresetId(presetId)) return { ...preferences };

  const nextVisibility = {
    ...preferences.modelPresetVisibility,
    [presetId]: visible,
  };
  if (!hasVisibleModelPreset(nextVisibility)) {
    nextVisibility[presetId] = true;
  }

  return {
    ...preferences,
    modelPresetVisibility: nextVisibility,
  };
}

export function getVisibleModelPresetIds(
  preferences: AgentPreferences,
  presetIds: readonly string[] = MODEL_PRESET_IDS,
): string[] {
  return presetIds.filter(
    (presetId) =>
      isModelPresetId(presetId) && preferences.modelPresetVisibility[presetId],
  );
}

function mergePermissionVisibility(
  value: unknown,
): Record<PermissionMode, boolean> {
  if (!isRecord(value)) {
    return { ...DEFAULT_AGENT_PREFERENCES.permissionModeVisibility };
  }

  return PERMISSION_MODES.reduce<Record<PermissionMode, boolean>>(
    (acc, mode) => {
      acc[mode] =
        typeof value[mode] === 'boolean'
          ? value[mode]
          : DEFAULT_AGENT_PREFERENCES.permissionModeVisibility[mode];
      return acc;
    },
    { ...DEFAULT_AGENT_PREFERENCES.permissionModeVisibility },
  );
}

function mergeModelPresetVisibility(
  value: unknown,
): Record<ModelPresetId, boolean> {
  if (!isRecord(value)) {
    return { ...DEFAULT_AGENT_PREFERENCES.modelPresetVisibility };
  }

  const visibility = MODEL_PRESET_IDS.reduce<Record<ModelPresetId, boolean>>(
    (acc, presetId) => {
      acc[presetId] =
        typeof value[presetId] === 'boolean'
          ? value[presetId]
          : DEFAULT_AGENT_PREFERENCES.modelPresetVisibility[presetId];
      return acc;
    },
    { ...DEFAULT_AGENT_PREFERENCES.modelPresetVisibility },
  );

  if (!hasVisibleModelPreset(visibility)) {
    visibility.claude = true;
  }

  return visibility;
}

function hasVisibleModelPreset(
  visibility: Record<ModelPresetId, boolean>,
): boolean {
  return MODEL_PRESET_IDS.some((presetId) => visibility[presetId]);
}

function isModelPresetId(value: string): value is ModelPresetId {
  return MODEL_PRESET_IDS.includes(value as ModelPresetId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
