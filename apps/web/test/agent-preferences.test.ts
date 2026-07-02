import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_AGENT_PREFERENCES,
  getVisiblePermissionModes,
  isLanguage,
  mergeAgentPreferences,
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

test('isLanguage narrows only supported UI languages', () => {
  assert.equal(isLanguage('en'), true);
  assert.equal(isLanguage('zh'), true);
  assert.equal(isLanguage('ja'), false);
});
