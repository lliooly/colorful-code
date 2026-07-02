import { PERMISSION_MODES, type PermissionMode } from './types';

export type Language = 'en' | 'zh';
export type ThemePreference = 'system' | 'light' | 'dark';

export type AgentPreferences = {
  language: Language;
  theme: ThemePreference;
  permissionModeVisibility: Record<PermissionMode, boolean>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
