import type { PrototypeNotice } from './api';
import type { Language } from './ui-language';

/** Only translate identified diagnostics with all their parameters; retain everything else. */
export function prototypeNotice(language: Language, notice: PrototypeNotice): string {
  if (typeof notice === 'string') return notice;
  const p = notice.params ?? {};
  const has = (...keys: string[]) => keys.every((key) => typeof p[key] === 'string' || typeof p[key] === 'number');
  switch (notice.code) {
    case 'PARENT_INSPECTION_NOTICE':
      return language === 'ru' ? notice.message : 'Normal declarations, a single parent and parent lists are supported. Changes go to the YAML draft; save with Ctrl+S.';
    case 'INHERIT_MULTIPLE_PARENTS':
      if (!has('id', 'count')) break;
      return language === 'ru' ? `${p.id}: ${p.count} родителя; порядок и DataField-семантика конфликтующих полей движка не подтверждены.` : `${p.id}: ${p.count} parents; the engine order and DataField semantics of conflicting fields are unconfirmed.`;
    case 'INHERIT_INVALID_PARENT':
      if (!has('id', 'parent')) break;
      return language === 'ru' ? `${p.id}: пустой или повторяющийся parent «${p.parent}».` : `${p.id}: empty or duplicate parent “${p.parent}”.`;
    case 'INHERIT_INDEX_INCOMPLETE':
      return language === 'ru' ? notice.message : 'The prototype catalog is incomplete: some YAML, IDs or partial configurations could not be indexed.';
    case 'INHERIT_OUTPUT_LIMIT':
      if (!has('fields', 'components')) break;
      return language === 'ru' ? `Вывод ограничен ${p.fields} полями и ${p.components} компонентами.` : `Output is limited to ${p.fields} fields and ${p.components} components.`;
    case 'LINKS_INDEX_INCOMPLETE':
      return language === 'ru' ? notice.message : 'Some YAML files were not indexed: some links may be missing.';
    case 'LINKS_OUTPUT_LIMIT':
      if (!has('rows', 'nodes')) break;
      return language === 'ru' ? `В Electron показывались первые ${p.rows} ссылки; просмотр ограничен ${p.rows} результатами и ${p.nodes} YAML-узлами.` : `Electron showed the first ${p.rows} links; this view is limited to ${p.rows} results and ${p.nodes} YAML nodes.`;
  }
  return notice.message;
}
