import type { CSharpDefinition, CSharpField } from '../lib/api';
import type { Language } from '../lib/ui-language';

function safeMarkdown(text: string): string {
  return text.replace(/[\x60\\<>{}\r\n]/g, '').slice(0, 180);
}

// Documentation is untrusted C# source, not Markdown or HTML.
function safeDocumentation(text: string): string {
  return text.slice(0, 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

/** Carry over Electron's YAML examples; they are illustrative, not engine-validated. */
export function sampleYamlValue(field: Pick<CSharpField, 'name' | 'field_type'>): string {
  const name = field.name.toLowerCase();
  const kind = field.field_type.toLowerCase();
  if (name === 'modifiers' || kind.includes('damagemodifierset')) {
    return 'coefficients:\n  Blunt: 0.6\n  Slash: 0.6\n  Piercing: 0.6\n  Heat: 0.8';
  }
  if (name.includes('sprite')) return '_Example/Path/example.rsi';
  if (name.includes('state')) return 'icon';
  if (kind.includes('bool')) return 'true';
  if (kind.includes('float') || kind.includes('double')) return '1.0';
  if (/int|short|long|byte/.test(kind)) return '1';
  if (/list|array|hashset|immutablearray/.test(kind)) return '[]';
  if (/dictionary|damage|map/.test(kind)) return '{}';
  return 'TODO';
}

export function componentYamlExample(definition: Pick<CSharpDefinition, 'name' | 'fields'>): string {
  const lines = ['- type: ' + safeMarkdown(definition.name)];
  for (const field of definition.fields.slice(0, 20)) {
    if (lines.length >= 9) break;
    if (!field.required && lines.length >= 4) continue;
    const sample = sampleYamlValue(field);
    const key = safeMarkdown(field.name);
    if (!key) continue;
    if (sample.includes('\n')) {
      lines.push('  ' + key + ':');
      for (const row of sample.split('\n')) lines.push('    ' + row);
    } else {
      lines.push('  ' + key + ': ' + sample);
    }
  }
  return lines.join('\n');
}

export function ambiguousComponentHoverMarkdown(name: string, language: Language): string {
  return '**' + safeDocumentation(name) + '** — ' + (language === 'en'
    ? 'C# schema is ambiguous or the index is incomplete. Check the source manually.'
    : 'C# схема неоднозначна или индекс неполный. Проверьте исходники вручную.');
}

export function componentHoverMarkdown(definition: CSharpDefinition, language: Language = 'ru'): string {
  const lines = [
    '### ' + safeMarkdown(definition.name),
    '\x60' + safeMarkdown(definition.class_name) + '\x60',
    '',
    (language === 'en' ? 'C# source: ' : 'C# исходник: ') + '\x60' + safeMarkdown(definition.file) + ':' + definition.line + '\x60',
  ];
  if (definition.summary) lines.push('', safeDocumentation(definition.summary));
  if (definition.fields.length) {
    lines.push('', language === 'en' ? '**Direct DataFields**' : '**Прямые DataField**');
    for (const field of definition.fields.slice(0, 20)) {
      lines.push('- \x60' + safeMarkdown(field.name) + '\x60: \x60' + safeMarkdown(field.field_type) + '\x60'
        + (field.required ? (language === 'en' ? ' (required)' : ' (обязательно)') : '')
        + (field.summary ? ' — ' + safeDocumentation(field.summary) : ''));
    }
  }
  lines.push('', language === 'en' ? '**Example YAML (template)**' : '**Пример YAML (шаблон)**', '\x60\x60\x60yaml', componentYamlExample(definition),
    '\x60\x60\x60', '', language === 'en'
      ? 'Only direct DataFields are shown, without verifying engine inheritance.'
      : 'Показаны только прямые DataField без проверки движкового наследования.');
  return lines.join('\n');
}
