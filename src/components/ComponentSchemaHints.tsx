import { AlertTriangle, FileCode2, Plus } from 'lucide-react';
import type { ComponentSchema, PrototypeComponentEntry } from '../lib/api';
import {
  suggestedFields, type EditableScalarKind,
} from '../lib/csharp-suggestions';

interface Props {
  component: PrototypeComponentEntry;
  schema: ComponentSchema | undefined;
  indexComplete: boolean;
  loading: boolean;
  disabled: boolean;
  onSelect: (index: number, key: string, kind: EditableScalarKind, value: string) => void;
}

const statuses: Record<Exclude<ComponentSchema['status'], 'unique'>, string> = {
  ambiguous: 'Несколько C#-классов для одного имени — схема неоднозначна.',
  partial: 'C#-класс partial: другие части класса пока не объединены.',
  uncertain: 'В C# есть синтаксическая неоднозначность. Подсказки отключены.',
  not_indexed: 'Соответствующий C#-класс не найден в индексе проекта.',
};

export default function ComponentSchemaHints({
  component, schema, indexComplete, loading, disabled, onSelect,
}: Props) {
  if (loading && !schema) {
    return <div className="component-schema-hints">
      <span>Поиск схемы C# для {component.type_name}…</span>
    </div>;
  }
  if (!schema) return null;

  const isUnique = schema.status === 'unique' && schema.declarations.length === 1;
  const canSuggest = isUnique && indexComplete;
  const definition = isUnique ? schema.declarations[0] : null;
  const suggestions = suggestedFields(component, schema, indexComplete);
  const partials = schema.status === 'partial' ? schema.parts : [];

  return <div className="component-schema-hints">
    <div className="component-schema-heading">
      <FileCode2 size={14}/>
      <strong>Схема C#</strong>
      {isUnique
        ? <span>{definition?.class_name}</span>
        : <span>{statuses[schema.status === 'unique' ? 'uncertain' : schema.status]}</span>}
    </div>
    {!indexComplete && <p className="component-schema-warning">
      <AlertTriangle size={13}/> Индекс C# неполный: автоматические подсказки отключены.
    </p>}
    {partials.length > 0 && <div className="component-schema-partials">
      <small>Найдены части одного C#-типа по полному имени
        <code>{partials[0].qualified_name}</code>. Они показаны только
        для ознакомления: сборка, условная компиляция и наследование не проверены.</small>
      {partials.map((part) =>
        <div className="component-schema-part" key={part.file + ':' + part.line}>
          <strong>{part.file}:{part.line}</strong>
          {part.parse_uncertain && <span>В этой части есть ошибка разбора.</span>}
          {part.fields.length === 0 && <span>Собственных DataField нет</span>}
          {part.fields.map((field, index) =>
            <span key={field.member + ':' + index}>
              <code>{field.name}</code> · {field.field_type} · строка {field.line}
            </span>)}
        </div>)}
    </div>}
    {!isUnique && schema.declarations.length > 0 && <div className="component-schema-sources">
      {schema.declarations.map((definition, i) =>
        <code key={definition.file + ':' + definition.line + ':' + i}>
          {definition.file}:{definition.line}
        </code>)}
    </div>}
    {definition && <>
      <small>Собственные DataField класса · {definition.file}:{definition.line}.
        Наследуемые и генерируемые поля пока не вычисляются.</small>
      {!definition.fields.length && <p>В этом объявлении собственных DataField нет.</p>}
      {definition.fields.length > 0 && <div className="component-schema-fields">
        {definition.fields.map((field, i) => {
          const existing = component.fields.some((item) => item.key === field.name);
          const suggestion = suggestions.find((item) => item.field.name === field.name);
          return <div className="component-schema-field" key={field.member + ':' + i}>
            <code>{field.name}</code>
            <span>{field.field_type}{field.required ? ' · required' : ''}</span>
            {existing ? <small>Есть в YAML</small>
              : suggestion?.kind && canSuggest
                ? <button type="button" disabled={disabled}
                    title={'Подставить ' + field.name + ' в форму добавления; YAML изменится только после подтверждения'}
                    onClick={() => onSelect(component.index, field.name,
                      suggestion.kind as EditableScalarKind, suggestion.defaultValue)}>
                    <Plus size={12}/> Заполнить
                  </button>
                : <small>Только вручную</small>}
          </div>;
        })}
      </div>}
    </>}
    {schema.status === 'not_indexed' && <small>
      Отсутствие схемы не означает, что компонент недопустим:
      регистрация может находиться в другом проекте или сгенерированном коде.
    </small>}
  </div>;
}
