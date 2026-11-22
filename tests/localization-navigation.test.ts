import assert from 'node:assert/strict';
import test from 'node:test';
import { missingLocaleFiles } from '../src/lib/localization-navigation';
import type { EntityLocalizationAnalysis } from '../src/lib/api';

const report: EntityLocalizationAnalysis = {
  localization_id: 'ent-item', complete: true, warnings: [],
  diagnostics: [
    {
      field: 'name', source_text: 'Name', missing_locales: ['ru-RU'],
      targets: [
        { locale: 'ru-RU', path: 'Resources/Locale/ru-RU/items.ftl',
          file_exists: true, exists: { name: false, description: false, suffix: false } },
        { locale: 'en-US', path: 'Resources/Locale/en-US/items.ftl',
          file_exists: true, exists: { name: true, description: true, suffix: true } },
      ],
    },
    {
      field: 'description', source_text: 'Description', missing_locales: ['ru-RU'],
      targets: [
        { locale: 'ru-RU', path: 'Resources/Locale/ru-RU/items.ftl',
          file_exists: true, exists: { name: false, description: false, suffix: false } },
      ],
    },
  ],
};

test('missing localization links open each existing game FTL once', () => {
  assert.deepEqual(missingLocaleFiles(report), [
    { locale: 'ru-RU', path: 'Resources/Locale/ru-RU/items.ftl' },
  ]);
});

test('incomplete or missing analysis never offers a translation shortcut', () => {
  assert.deepEqual(missingLocaleFiles({ ...report, complete: false }), []);
  assert.deepEqual(missingLocaleFiles(null), []);
});

test('missing on-disk files are offered for creation but not an open action', () => {
  const absent = {
    ...report, diagnostics: report.diagnostics.map((issue) => ({
      ...issue, targets: issue.targets.map((target) => ({ ...target, file_exists: false })),
    })),
  };
  assert.deepEqual(missingLocaleFiles(absent), []);
});
