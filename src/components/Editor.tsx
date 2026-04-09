import { useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import MonacoEditor from '@monaco-editor/react';
import { Save, AlertCircle } from 'lucide-react';
import { parseDocument } from 'yaml';
import { useI18n } from '../i18n';

export default function Editor() {
  const { t } = useI18n();
  const projectRoot = useProjectStore((state) => state.projectRoot);
  const editorJumpQuery = useProjectStore((state) => state.editorJumpQuery);
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const tabsById = useProjectStore((state) => state.tabsById);
  const setSelectedEditorTab = useProjectStore((state) => state.setSelectedEditorTab);
  const setEditorJumpQuery = useProjectStore((state) => state.setEditorJumpQuery);
  const updateActivePrototypeDetail = useProjectStore((state) => state.updateActivePrototypeDetail);
  const updateActivePrototypeDraft = useProjectStore((state) => state.updateActivePrototypeDraft);
  const updateActivePrototypeSaved = useProjectStore((state) => state.updateActivePrototypeSaved);
  const editorRef = useRef<any>(null);
  const activePrototypeTab = useMemo(
    () => {
      const tab = activeTabId ? tabsById[activeTabId] : null;
      return tab?.kind === 'prototype' ? tab : null;
    },
    [activeTabId, tabsById],
  );
  const detail = activePrototypeTab?.detail ?? null;
  const proto = detail?.prototype ?? null;
  const editorTab = activePrototypeTab?.editorTab ?? 'form';
  const yamlContent = activePrototypeTab?.rawYaml ?? '';
  const isDirty = activePrototypeTab?.dirty ?? false;

  useEffect(() => {
    if (!activePrototypeTab?.prototypeKey || !isDirty) return;
    const handle = window.setTimeout(async () => {
      const nextDetail = await window.prototypeStudio.validatePrototypeYaml({ key: activePrototypeTab.prototypeKey, text: yamlContent });
      if (nextDetail) updateActivePrototypeDetail(nextDetail, { preserveDraft: true, dirty: true });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [activePrototypeTab?.prototypeKey, isDirty, updateActivePrototypeDetail, yamlContent]);

  useEffect(() => {
    if (!editorRef.current || editorTab !== 'raw' || !editorJumpQuery) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;
    const matches = model.findMatches(editorJumpQuery, true, false, false, null, true);
    const match = matches[0];
    if (!match) return;
    editorRef.current.revealLineInCenter(match.range.startLineNumber);
    editorRef.current.setPosition({ lineNumber: match.range.startLineNumber, column: match.range.startColumn });
    editorRef.current.focus();
    setEditorJumpQuery(null);
  }, [editorJumpQuery, editorTab, setEditorJumpQuery, yamlContent]);

  if (!proto) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500 bg-neutral-950">{t('editor.empty')}</div>;
  }

  const handleSave = async () => {
    if (!projectRoot) return;
    try {
      const doc = parseDocument(yamlContent);
      if (doc.errors.length > 0) {
        alert(t('editor.invalidYaml'));
        return;
      }

      const saved = await window.prototypeStudio.savePrototype({
        projectRoot,
        filePath: proto._filePath,
        line: proto._line,
        text: yamlContent,
      });

      const refreshed = await window.prototypeStudio.getPrototype(activePrototypeTab!.prototypeKey);
      updateActivePrototypeSaved(refreshed, saved.text);
    } catch (error) {
      console.error("Failed to save", error);
      alert(error instanceof Error ? error.message : t('editor.saveFailed'));
    }
  };

  const registerCompletion = (monaco: any) => {
    const anyWindow = window as any;
    anyWindow.__prototypeStudioCompletion?.dispose?.();
    anyWindow.__prototypeStudioHover?.dispose?.();
    anyWindow.__prototypeStudioCompletion = monaco.languages.registerCompletionItemProvider('yaml', {
      triggerCharacters: [' ', ':', '-', '"', '/', '.'],
      provideCompletionItems: async (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const yamlContext = getYamlCompletionContext(model, position);
        const suggestions = await window.prototypeStudio.autocomplete({
          query: yamlContext.query ?? word?.word ?? '',
          limit: 120,
          context: yamlContext.context,
          componentType: yamlContext.componentType,
        });
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: yamlContext.startColumn ?? word?.startColumn ?? position.column,
          endColumn: word?.endColumn ?? position.column,
        };
        return {
          suggestions: suggestions.map((suggestion) => ({
            label: suggestion.label,
            kind: suggestion.kind === 'component' ? monaco.languages.CompletionItemKind.Class : monaco.languages.CompletionItemKind.Field,
            insertText: yamlContext.context === 'componentEntryStart' && linePrefix.trimEnd().endsWith('-') && !linePrefix.endsWith(' ')
              ? ` ${suggestion.insertText}`
              : suggestion.insertText,
            detail: suggestion.detail,
            documentation: suggestion.documentation,
            range,
            sortText: suggestionSortText(suggestion.label, yamlContext.query ?? word?.word ?? ''),
            preselect: isBestSuggestion(suggestion.label, yamlContext.query ?? word?.word ?? ''),
            command: yamlContext.context === 'componentEntryStart'
              ? { id: 'editor.action.triggerSuggest', title: 'Suggest components' }
              : undefined,
          })),
        };
      },
    });
    anyWindow.__prototypeStudioHover = monaco.languages.registerHoverProvider('yaml', {
      provideHover: async (model: any, position: any) => {
        const target = getYamlHoverTarget(model, position);
        if (!target) return null;
        const component = await window.prototypeStudio.componentInfo(target.componentType);
        if (!component) return null;
        return {
          range: target.range,
          contents: [{ value: componentHoverMarkdown(component) }],
        };
      },
    });
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-neutral-950">
      <div className="h-12 border-b border-neutral-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="font-medium text-neutral-200 truncate">{text(proto.id)}</h2>
          <span className="text-xs text-neutral-500 truncate">{proto._filePath}:{proto._line}</span>
          <div className="flex bg-neutral-900 rounded-md p-0.5 border border-neutral-800">
            {(['form', 'raw', 'resolved'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setSelectedEditorTab(tab)}
                className={`px-3 py-1 text-xs font-medium rounded-sm capitalize transition-colors ${
                  editorTab === tab ? 'bg-neutral-800 text-neutral-100 shadow-sm' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {t(`editor.tab.${tab}`)}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={!isDirty}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isDirty ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
          }`}
        >
          <Save size={14} />
          {t('editor.save')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto relative">
        {editorTab === 'form' && (
          <div className="p-6 max-w-3xl mx-auto space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-neutral-400">{t('editor.field.id')}</label>
                <input type="text" value={text(proto.id)} readOnly className="w-full bg-neutral-900 border border-neutral-800 rounded-md px-3 py-2 text-sm text-neutral-300 focus:outline-none" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-neutral-400">{t('editor.field.name')}</label>
                <input type="text" value={text(proto.name)} readOnly className="w-full bg-neutral-900 border border-neutral-800 rounded-md px-3 py-2 text-sm text-neutral-300 focus:outline-none" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-400">{t('editor.field.description')}</label>
              <textarea value={proto.description || ''} readOnly className="w-full bg-neutral-900 border border-neutral-800 rounded-md px-3 py-2 text-sm text-neutral-300 focus:outline-none min-h-[80px]" />
            </div>
            <div className="p-4 bg-blue-900/20 border border-blue-900/50 rounded-md flex gap-3 text-blue-200 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <p>{t('editor.rawHint')}</p>
            </div>
          </div>
        )}

        {editorTab === 'raw' && (
          <MonacoEditor
            height="100%"
            language="yaml"
            theme="vs-dark"
            value={yamlContent}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            onChange={(value) => {
              if (value !== undefined) {
                updateActivePrototypeDraft(value);
              }
            }}
            beforeMount={registerCompletion}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              quickSuggestions: { other: true, comments: false, strings: true },
              suggest: { showWords: false, localityBonus: true },
            }}
          />
        )}

        {editorTab === 'resolved' && (
          <div className="p-6">
            <pre className="text-xs font-mono text-neutral-300 bg-neutral-900 p-4 rounded-md overflow-x-auto">
              {JSON.stringify(detail?.resolved, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function text(value: unknown) {
  return value == null ? '' : String(value);
}

function suggestionSortText(label: string, query: string) {
  const normalized = query.trim().toLowerCase();
  const value = label.toLowerCase();
  if (!normalized) return `1_${value}`;
  if (value === normalized) return `0_${value}`;
  if (value.startsWith(normalized)) return `1_${value.length}_${value}`;
  const index = value.indexOf(normalized);
  return index >= 0 ? `2_${index}_${value.length}_${value}` : `9_${value}`;
}

function isBestSuggestion(label: string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return label.toLowerCase() === normalized || label.toLowerCase().startsWith(normalized);
}

function getYamlCompletionContext(model: any, position: any): {
  context: 'any' | 'componentEntryStart' | 'componentType' | 'componentField';
  componentType?: string;
  query?: string;
  startColumn?: number;
} {
  const line = model.getLineContent(position.lineNumber);
  const linePrefix = line.slice(0, position.column - 1);
  const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
  const typeMatch = linePrefix.match(/^(\s*-\s*type:\s*)([\w-]*)$/);
  if (typeMatch) {
    return { context: 'componentType', query: typeMatch[2], startColumn: typeMatch[1].length + 1 };
  }

  const entryMatch = linePrefix.match(/^(\s*-\s*)([\w-]*)$/);
  if (entryMatch && isInsideComponents(model, position.lineNumber)) {
    return {
      context: 'componentEntryStart',
      query: entryMatch[2],
      startColumn: entryMatch[1].length + 1,
    };
  }

  const componentType = nearestComponentType(model, position.lineNumber, currentIndent);
  if (componentType) {
    return { context: 'componentField', componentType };
  }

  return { context: 'any' };
}

function nearestComponentType(model: any, lineNumber: number, currentIndent: number) {
  for (let line = lineNumber - 1; line >= 1; line -= 1) {
    const content = model.getLineContent(line);
    const match = content.match(/^(\s*)-\s*type:\s*([A-Za-z0-9_]+)\s*$/);
    if (!match) continue;
    const componentIndent = match[1].length;
    if (currentIndent > componentIndent) return match[2];
    return null;
  }
  return null;
}

function isInsideComponents(model: any, lineNumber: number) {
  for (let line = lineNumber - 1; line >= 1; line -= 1) {
    const content = model.getLineContent(line);
    if (/^\s*components:\s*$/.test(content)) return true;
    if (/^-\s*type:\s*\S+/.test(content)) return false;
  }
  return false;
}

function getYamlHoverTarget(model: any, position: any) {
  const line = model.getLineContent(position.lineNumber);
  const match = line.match(/^(\s*-\s*type:\s*)([A-Za-z0-9_]+)\b/);
  if (!match) return null;
  const startColumn = match[1].length + 1;
  const endColumn = startColumn + match[2].length;
  if (position.column < startColumn || position.column > endColumn) return null;
  return {
    componentType: match[2],
    range: {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn,
      endColumn,
    },
  };
}

function componentHoverMarkdown(component: any) {
  const lines = [
    `### ${component.name}`,
    `\`${component.className}\``,
  ];
  if (component.description) lines.push('', component.description);
  lines.push('', `Source: \`${component.path}:${component.line}\``);

  const fields = component.fields ?? [];
  if (fields.length > 0) {
    lines.push('', '**Parameters**');
    for (const field of fields.slice(0, 20)) {
      const required = field.required ? ' required' : '';
      const description = field.description ? ` - ${field.description}` : '';
      lines.push(`- \`${field.name}\`: \`${field.type}\`${required}${description}`);
    }
  }

  lines.push('', '**Example**', '```yaml', componentExampleYaml(component), '```');
  return lines.join('\n');
}

function componentExampleYaml(component: any) {
  const lines = [`- type: ${component.name}`];
  for (const field of (component.fields ?? []).slice(0, 8)) {
    if (!field.required && lines.length >= 4) continue;
    const sample = sampleYamlValue(field);
    if (sample.includes('\n')) {
      lines.push(`  ${field.name}:`);
      for (const nested of sample.split('\n')) lines.push(`    ${nested}`);
    } else {
      lines.push(`  ${field.name}: ${sample}`);
    }
  }
  return lines.join('\n');
}

function sampleYamlValue(field: any) {
  const name = String(field.name).toLowerCase();
  const type = String(field.type).toLowerCase();
  if (name === 'modifiers' || type.includes('damagemodifierset')) {
    return [
      'coefficients:',
      '  Blunt: 0.6',
      '  Slash: 0.6',
      '  Piercing: 0.6',
      '  Heat: 0.8',
    ].join('\n');
  }
  if (name.includes('sprite')) return '_Example/Path/example.rsi';
  if (name.includes('state')) return 'icon';
  if (type.includes('bool')) return 'true';
  if (type.includes('float') || type.includes('double')) return '1.0';
  if (type.includes('int')) return '1';
  if (type.includes('list') || type.includes('array') || type.includes('hashset')) return '[]';
  if (type.includes('dictionary') || type.includes('damage')) return '{}';
  return 'TODO';
}
