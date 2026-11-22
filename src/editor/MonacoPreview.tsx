import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { studio, type ResourceDocument, type ResourceEntry } from '../lib/api';
import { yamlCompletionContext, yamlComponentHoverTarget, yamlSpriteLinkTarget } from './yaml-completion';
import { componentHoverMarkdown } from './component-hover';
import { yamlLocaleClickField } from './yaml-locale-navigation';
import { missingEntityLocaleUnderlines } from './yaml-locale-markers';
import type { EditorSettings } from '../lib/editor-settings';
import { identifierAtColumn } from '../lib/editor-navigation';

interface Props {
  settings: EditorSettings;
  resource: ResourceEntry;
  document: ResourceDocument;
  revealLine?: number;
  jumpToken?: number;
  value: string;
  editable: boolean;
  onChange?: (value: string) => void;
  onNavigateIdentifier?: (identifier: string) => void;
  onNavigateRsi?: (indexedPath: string) => void;
  onNavigateLocalization?: (line: number, source: string) => void;
  gameLocales?: readonly string[];
}

/**
 * Lazy-loads Monaco only when a resource is opened, and disposes the model,
 * workers' consumers and editor on tab switch/unmount.
 */
export default function MonacoPreview({ resource, document, revealLine, jumpToken, value, editable, onChange, onNavigateIdentifier, onNavigateRsi, onNavigateLocalization, gameLocales = [], settings }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ revealLineInCenter(line: number): void; setPosition(position: { lineNumber: number; column: number }): void } | null>(null);
  const latestJump = useRef(revealLine);
  const contentRef = useRef<{ getValue(): string; setValue(value: string): void } | null>(null);
  const updateOptionsRef = useRef<{ updateOptions(value: {
    readOnly?: boolean; domReadOnly?: boolean; fontSize?: number; tabSize?: number;
    wordWrap?: 'on' | 'off'; lineNumbers?: 'on' | 'off' | 'relative';
    minimap?: { enabled: boolean };
  }): void } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onNavigateRef = useRef(onNavigateIdentifier);
  onNavigateRef.current = onNavigateIdentifier;
  const onNavigateRsiRef = useRef(onNavigateRsi);
  onNavigateRsiRef.current = onNavigateRsi;
  const onNavigateLocalizationRef = useRef(onNavigateLocalization);
  onNavigateLocalizationRef.current = onNavigateLocalization;
  const gameLocaleKey = gameLocales.join('\u0000');
  const localeValidationRef = useRef({
    enabled: settings.liveValidation,
    delayMs: settings.validationDelay,
    locales: [...gameLocales],
  });
  localeValidationRef.current = {
    enabled: settings.liveValidation,
    delayMs: settings.validationDelay,
    locales: [...gameLocales],
  };
  const scheduleLocaleDiagnostics = useRef<(() => void) | null>(null);
  useEffect(() => {
    scheduleLocaleDiagnostics.current?.();
  }, [settings.liveValidation, settings.validationDelay, gameLocaleKey]);

  // A new disk revision or a discarded draft updates Monaco without losing
  // text typed before a React rerender. Ordinary keystrokes do not reset undo.
  useEffect(() => {
    if (contentRef.current && contentRef.current.getValue() !== value) {
      contentRef.current.setValue(value);
    }
  }, [value]);

  useEffect(() => {
    updateOptionsRef.current?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
    });
  }, [editable]);
  useEffect(() => {
    updateOptionsRef.current?.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap,
      lineNumbers: settings.lineNumbers,
      minimap: { enabled: settings.minimap },
    });
  }, [settings]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    latestJump.current = revealLine;
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
    }
  }, [revealLine, jumpToken]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setFailure(null);
    setLoading(true);

    async function mount() {
      try {
        const { monaco, resourceLanguage } = await import('./monaco');
        if (cancelled || !containerRef.current) return;

        const model = monaco.editor.createModel(value, resourceLanguage(resource.kind));
        try {
          const editor = monaco.editor.create(containerRef.current, {
            model,
            theme: 'ss14-dark',
            readOnly: !editable,
            domReadOnly: !editable,
            automaticLayout: true,
            minimap: { enabled: settingsRef.current.minimap },
            fontSize: settingsRef.current.fontSize,
            tabSize: settingsRef.current.tabSize,
            lineNumbers: settingsRef.current.lineNumbers,
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            renderWhitespace: 'selection',
            wordWrap: settingsRef.current.wordWrap,
            padding: { top: 14, bottom: 14 },
            overviewRulerBorder: false,
          });
          editorRef.current = editor;
          contentRef.current = model;
          updateOptionsRef.current = editor;
          const subscription = editor.onDidChangeModelContent(() => {
            onChangeRef.current?.(editor.getValue());
            scheduleLocaleDiagnostics.current?.();
          });
          // Restore Electron's indexed parent/component completions. Provider
          // belongs to the current Monaco model and is disposed with the tab.
          const completions = resource.kind === 'yaml'
            ? monaco.languages.registerCompletionItemProvider('yaml', {
              triggerCharacters: [' ', ':', '-', ',', '[', '/', '.', '"'],
              provideCompletionItems: async (source, position, _context, token) => {
                if (source !== model || token.isCancellationRequested) return { suggestions: [] };
                const first = Math.max(1, position.lineNumber - 64);
                const lines = Array.from({ length: position.lineNumber - first + 1 },
                  (_, offset) => source.getLineContent(first + offset));
                const target = yamlCompletionContext(lines, lines.length, position.column);
                if (!target) return { suggestions: [] };
                try {
                  let entries: { label: string; detail: string; insertText?: string }[] = [];
                  if (target.kind === 'prototype-parent') {
                    const page = await studio.searchPrototypes(target.query, '', 0, 80);
                    entries = page.items.map((item) => ({
                      label: item.id, detail: item.kind + ' · ' + item.file,
                    }));
                  } else if (target.kind === 'component-type' || target.kind === 'component-entry-start') {
                    const page = await studio.searchCSharpDefinitions(target.query, 'component', 0, 80);
                    if (page.complete) entries = page.items.map((item) => ({
                      label: item.name, detail: item.class_name + ' · ' + item.file,
                      insertText: target.kind === 'component-entry-start' ? 'type: ' + item.name : item.name,
                    }));
                  } else if (target.kind === 'component-field') {
                    const batch = await studio.inspectComponentSchemas([target.componentType!]);
                    const schema = batch.components.find((item) => item.type_name === target.componentType);
                    if (batch.index_complete && schema?.status === 'unique' && schema.declarations.length === 1
                        && !schema.declarations[0].parse_uncertain) {
                      const used = new Set(target.existingFields ?? []);
                      entries = schema.declarations[0].fields.filter((item) => !used.has(item.name))
                        .map((item) => ({
                          label: item.name, detail: item.field_type + (item.required ? ' · required' : ''),
                          insertText: item.name + ': ',
                        }));
                    }
                  } else if (target.kind === 'rsi-path') {
                    const page = await studio.searchResources(target.query, 'rsi', 0, 80);
                    entries = page.items.filter((item) => item.path.startsWith('Resources/Textures/'))
                      .map((item) => ({
                        label: item.path.slice('Resources/Textures/'.length),
                        detail: item.path,
                      }));
                  }
                  if (token.isCancellationRequested || cancelled) return { suggestions: [] };
                  const seen = new Set<string>();
                  const candidates = entries.flatMap((item) => {
                    if (!item.label.toLowerCase().startsWith(target.query.toLowerCase())) return [];
                    if (seen.has(item.label)) return [];
                    seen.add(item.label);
                    return [{
                      label: item.label,
                      kind: target.kind === 'component-type' || target.kind === 'component-entry-start'
                        ? monaco.languages.CompletionItemKind.Class
                        : target.kind === 'component-field'
                          ? monaco.languages.CompletionItemKind.Field
                          : target.kind === 'rsi-path'
                            ? monaco.languages.CompletionItemKind.File
                            : monaco.languages.CompletionItemKind.Reference,
                      insertText: item.insertText ?? item.label,
                      detail: item.detail,
                      range: {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: target.startColumn,
                        endColumn: position.column,
                      },
                    }];
                  });
                  return { suggestions: candidates };
                } catch {
                  // A malformed/stale index must not make editing YAML impossible.
                  return { suggestions: [] };
                }
              },
            }) : null;
          const componentHover = resource.kind === 'yaml'
            ? monaco.languages.registerHoverProvider('yaml', {
              provideHover: async (source, position, token) => {
                if (source !== model || token.isCancellationRequested) return null;
                const first = Math.max(1, position.lineNumber - 64);
                const lines = Array.from({ length: position.lineNumber - first + 1 },
                  (_, offset) => source.getLineContent(first + offset));
                const hover = yamlComponentHoverTarget(lines, lines.length, position.column);
                if (!hover) return null;
                try {
                  const batch = await studio.inspectComponentSchemas([hover.name]);
                  if (token.isCancellationRequested || cancelled) return null;
                  const schema = batch.components.find((item) => item.type_name === hover.name);
                  if (!schema) return null;
                  const title = hover.name.replace(/[`\\]/g, '');
                  const status = schema.status === 'unique' && batch.index_complete
                    && schema.declarations.length === 1;
                  const definition = status ? schema.declarations[0] : null;
                  const content = definition
                    ? componentHoverMarkdown(definition)
                    : '**' + title
                      + '** — C# схема неоднозначна или индекс неполный. Проверьте исходники вручную.';
                  return {
                    range: new monaco.Range(position.lineNumber, hover.startColumn,
                      position.lineNumber, hover.endColumn),
                    contents: [{ value: content }],
                  };
                } catch {
                  return null;
                }
              },
            }) : null;
          const navigateSubscription = editor.onMouseDown((event) => {
            if (!settingsRef.current.ctrlClickNavigation) return;
            if (!(event.event.ctrlKey || event.event.metaKey) || !event.event.leftButton) return;
            const position = event.target.position;
            if (!position) return;
            const line = model.getLineContent(position.lineNumber);
            if (resource.kind === 'yaml' && onNavigateRsiRef.current) {
              const first = Math.max(1, position.lineNumber - 128);
              const lines = Array.from({ length: position.lineNumber - first + 1 },
                (_, offset) => model.getLineContent(first + offset));
              const indexedPath = yamlSpriteLinkTarget(lines, lines.length, position.column);
              if (indexedPath) {
                onNavigateRsiRef.current(indexedPath);
                return;
              }
              if (/^\s*sprite:\s*/.test(line)) return;
            }
            if (resource.kind === 'yaml' && onNavigateLocalizationRef.current
              && yamlLocaleClickField(line, position.column)) {
              onNavigateLocalizationRef.current(position.lineNumber, model.getValue());
              return;
            }
            const identifier = identifierAtColumn(line, position.column);
            if (identifier) onNavigateRef.current?.(identifier);
          });
          // Electron's red wavy underline on missing translations in the
          // current entity. Unlike broad regex scans this uses the native
          // source outline and Fluent index, never the Studio UI language.
          let localeEpoch = 0;
          let localeTimer: number | undefined;
          let localeDecorations: string[] = [];
          function clearLocaleDecorations() {
            localeDecorations = editor.deltaDecorations(localeDecorations, []);
          }
          function scheduleLocaleCheck() {
            const epoch = ++localeEpoch;
            if (localeTimer !== undefined) window.clearTimeout(localeTimer);
            const config = localeValidationRef.current;
            if (resource.kind !== 'yaml' || !config.enabled || !config.locales.length) {
              clearLocaleDecorations();
              return;
            }
            const sourceText = model.getValue();
            const cursor = editor.getPosition();
            if (!cursor) {
              clearLocaleDecorations();
              return;
            }
            // Decorations from the previous cursor or text are not valid for
            // the new entity. No warning before native index confirms it.
            clearLocaleDecorations();
            localeTimer = window.setTimeout(() => {
              void (async () => {
                try {
                  const outline = await studio.inspectYamlOutline(document.path, sourceText);
                  if (cancelled || epoch !== localeEpoch || outline.truncated
                    || model.getValue() !== sourceText) return;
                  const entries = outline.declarations.map((entry) => entry.declaration)
                    .sort((a, b) => a.line - b.line);
                  const index = entries.findIndex((entry, i) =>
                    entry.line <= cursor.lineNumber
                      && (i + 1 === entries.length || entries[i + 1].line > cursor.lineNumber));
                  if (index < 0 || entries[index].kind !== 'entity'
                    || entries[index].mode !== 'normal') return;
                  const entity = entries[index];
                  const report = await studio.analyzeEntityLocalization(
                    entity, sourceText, config.locales,
                  );
                  if (cancelled || epoch !== localeEpoch || model.getValue() !== sourceText
                    || !report.complete) return;
                  const nextLine = index + 1 < entries.length ? entries[index + 1].line : null;
                  const underlines = missingEntityLocaleUnderlines(
                    sourceText.split('\n'), entity, nextLine, report.diagnostics,
                  );
                  localeDecorations = editor.deltaDecorations(localeDecorations,
                    underlines.map((mark) => ({
                      range: new monaco.Range(mark.line, mark.startColumn,
                        mark.line, mark.endColumn),
                      options: {
                        inlineClassName: 'studio-loc-missing',
                        hoverMessage: [{
                          value: 'Игровой перевод ' + mark.field
                            + ' отсутствует: ' + mark.locales.join(', ')
                            + '. Ctrl+Click — открыть исправление.',
                        }],
                      },
                    })));
                } catch {
                  if (!cancelled && epoch === localeEpoch) clearLocaleDecorations();
                }
              })();
            }, Math.max(100, Math.min(config.delayMs, 1500)));
          }
          scheduleLocaleDiagnostics.current = scheduleLocaleCheck;
          const cursorSubscription = editor.onDidChangeCursorPosition(scheduleLocaleCheck);
          if (latestJump.current) {
            editor.revealLineInCenter(latestJump.current);
            editor.setPosition({ lineNumber: latestJump.current, column: 1 });
          }
          scheduleLocaleCheck();
          dispose = () => {
            localeEpoch++;
            if (localeTimer !== undefined) window.clearTimeout(localeTimer);
            scheduleLocaleDiagnostics.current = null;
            cursorSubscription.dispose();
            clearLocaleDecorations();
            subscription.dispose();
            navigateSubscription.dispose();
            completions?.dispose();
            componentHover?.dispose();
            contentRef.current = null;
            updateOptionsRef.current = null;
            editorRef.current = null;
            editor.dispose();
            model.dispose();
          };
          if (!cancelled) setLoading(false);
        } catch (error) {
          model.dispose();
          throw error;
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      }
    }

    void mount();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [document.path, resource.kind]);

  if (failure) {
    return <div className="monaco-fallback" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>Не удалось загрузить редактор Monaco.</strong>
        <p>Предпросмотр содержимого доступен ниже. Редактирование через Monaco недоступно, если компонент не загрузился.</p>
        <details><summary>Техническая ошибка</summary><pre>{failure}</pre></details>
      </div>
      <pre className="fallback-content"><code>{document.content}</code></pre>
    </div>;
  }
  return <div className="monaco-shell">
    <div ref={containerRef} className="monaco-container" aria-label={(editable ? 'Редактирование: ' : 'Только чтение: ') + document.path}/>
    {loading && <div className="monaco-loading" role="status">Загрузка редактора…</div>}
  </div>;
}
