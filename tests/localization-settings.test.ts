import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCALIZATION_SETTINGS, LOCALIZATION_SETTINGS_KEY,
  readLocalizationSettings, sanitizeLocalizationSettings,
  localeResourceSearch, localeFromFtlPath,
} from '../src/lib/localization-settings';
import { uiText } from '../src/lib/ui-language';

test('missing, blocked and corrupted project locale preferences use Electron default', () => {
  assert.deepEqual(readLocalizationSettings({ getItem: () => null }), DEFAULT_LOCALIZATION_SETTINGS);
  assert.deepEqual(readLocalizationSettings({ getItem: () => '{broken' }), DEFAULT_LOCALIZATION_SETTINGS);
  assert.deepEqual(readLocalizationSettings({ getItem: () => { throw Error('blocked'); } }), DEFAULT_LOCALIZATION_SETTINGS);
});
test('Electron project locale preference is portable and sanitized', () => {
  const value = { requiredLocales: ['ru-RU', 'en-US', 'RU-ru', '', '../unsafe', 'zh-Hant-TW'] };
  const storage = { getItem: (key: string) => key === LOCALIZATION_SETTINGS_KEY ? JSON.stringify(value) : null };
  assert.deepEqual(readLocalizationSettings(storage).requiredLocales, ['ru-RU', 'en-US', 'zh-Hant-TW']);
  assert.deepEqual(sanitizeLocalizationSettings({ requiredLocales: [] }), DEFAULT_LOCALIZATION_SETTINGS);
  assert.deepEqual(sanitizeLocalizationSettings('invalid'), DEFAULT_LOCALIZATION_SETTINGS);
  assert.deepEqual(sanitizeLocalizationSettings({ requiredLocales: [null, 8, 'en-US'] }).requiredLocales, ['en-US']);
});
test('project locales do not change editor UI language', () => {
  const locales = sanitizeLocalizationSettings({ requiredLocales: ['en-US'] });
  assert.deepEqual(locales.requiredLocales, ['en-US']);
  assert.equal(uiText('ru', 'settings.general'), 'Общие');
  assert.equal(uiText('en', 'settings.general'), 'General');
});
test('FTL locale navigation targets only indexed resource paths', () => {
  assert.equal(localeResourceSearch('ru-RU'), '/Locale/ru-RU/');
  assert.equal(localeResourceSearch('../unsafe'), '');
  assert.equal(localeFromFtlPath('Resources/Locale/ru-RU/prototypes/foo.ftl'), 'ru-RU');
  assert.equal(localeFromFtlPath('Content.Server/Resources/Locale/en-US/foo.ftl'), 'en-US');
  assert.equal(localeFromFtlPath('Resources\\Locale\\zh-Hant-TW\\foo.ftl'), 'zh-Hant-TW');
  assert.equal(localeFromFtlPath('Resources/Locale/foo.ftl'), null);
  assert.equal(localeFromFtlPath('Resources/Prototypes/ru-RU/foo.yml'), null);
});
