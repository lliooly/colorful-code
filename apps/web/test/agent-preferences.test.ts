import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_AGENT_PREFERENCES,
  getVisibleModelPresetIds,
  getVisiblePermissionModes,
  isLanguage,
  mergeAgentPreferences,
  setModelPresetVisibility,
  setPermissionModeVisibility,
} from '../app/agent/preferences';

test('mergeAgentPreferences keeps defaults when storage is empty or invalid', () => {
  assert.deepEqual(mergeAgentPreferences(null), DEFAULT_AGENT_PREFERENCES);
  assert.deepEqual(
    mergeAgentPreferences({ language: 'fr', theme: 'solarized' }),
    DEFAULT_AGENT_PREFERENCES,
  );
  assert.equal(DEFAULT_AGENT_PREFERENCES.theme, 'system');
});

test('mergeAgentPreferences accepts supported language, theme, and visibility flags', () => {
  const preferences = mergeAgentPreferences({
    language: 'zh',
    theme: 'dark',
    permissionModeVisibility: {
      default: false,
      plan: true,
      acceptEdits: false,
      readOnly: true,
      bypass: false,
    },
  });

  assert.equal(preferences.language, 'zh');
  assert.equal(preferences.theme, 'dark');
  assert.deepEqual(getVisiblePermissionModes(preferences), [
    'plan',
    'readOnly',
  ]);
});

test('setPermissionModeVisibility updates a single permission mode without mutating the original', () => {
  const next = setPermissionModeVisibility(
    DEFAULT_AGENT_PREFERENCES,
    'bypass',
    false,
  );

  assert.equal(DEFAULT_AGENT_PREFERENCES.permissionModeVisibility.bypass, true);
  assert.equal(next.permissionModeVisibility.bypass, false);
  assert.deepEqual(getVisiblePermissionModes(next), [
    'default',
    'plan',
    'acceptEdits',
    'readOnly',
  ]);
});

test('mergeAgentPreferences keeps model presets visible by default and ignores unknown presets', () => {
  const preferences = mergeAgentPreferences({
    modelPresetVisibility: {
      claude: false,
      deepseek: true,
      unknown: false,
    },
  });

  assert.deepEqual(getVisibleModelPresetIds(preferences), [
    'deepseek',
    'openai',
    'custom',
  ]);
});

test('mergeAgentPreferences preserves at least one enabled model preset', () => {
  const preferences = mergeAgentPreferences({
    modelPresetVisibility: {
      claude: false,
      deepseek: false,
      openai: false,
      custom: false,
    },
  });

  assert.deepEqual(getVisibleModelPresetIds(preferences), ['claude']);
});

test('setModelPresetVisibility refuses to hide the last visible model preset', () => {
  const oneVisible = mergeAgentPreferences({
    modelPresetVisibility: {
      claude: true,
      deepseek: false,
      openai: false,
      custom: false,
    },
  });

  const next = setModelPresetVisibility(oneVisible, 'claude', false);

  assert.deepEqual(getVisibleModelPresetIds(next), ['claude']);
  assert.notEqual(next, oneVisible);
});

test('isLanguage narrows only supported UI languages', () => {
  assert.equal(isLanguage('en'), true);
  assert.equal(isLanguage('zh'), true);
  assert.equal(isLanguage('ja'), false);
});
