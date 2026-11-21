import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Columns2 } from 'lucide-react';

const MAX_DIFF_CHARS = 1_000_000;

interface Props {
  original: string;
  modified: string;
  originalLabel?: string;
  modifiedLabel?: string;
  fileLabel?: string;
}

/** Read-only source comparison, never a YAML merge or file-writing operation. */
export default function YamlDiffView({
  original, modified,
  originalLabel = 'Текущий файл на диске',
  modifiedLabel = 'Черновик',
  fileLabel = 'YAML',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<{
    updateOptions(value: { renderSideBySide?: boolean; ignoreTrimWhitespace?: boolean }): void;
  } | null>(null);
  const modelsRef = useRef<{
    original: { getValue(): string; setValue(value: string): void };
    modified: { getValue(): string; setValue(value: string): void };
  } | null>(null);
  const latest = useRef({ original, modified });
  latest.current = { original, modified };

  const [sideBySide, setSideBySide] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const tooLarge = original.length > MAX_DIFF_CHARS || modified.length > MAX_DIFF_CHARS;

  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    if (models.original.getValue() !== original) models.original.setValue(original);
    if (models.modified.getValue() !== modified) models.modified.setValue(modified);
  }, [original, modified]);

  useEffect(() => {
    diffRef.current?.updateOptions({
      renderSideBySide: sideBySide,
      ignoreTrimWhitespace: ignoreWhitespace,
    });
  }, [sideBySide, ignoreWhitespace]);

  useEffect(() => {
    if (tooLarge) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setLoading(true);
    setFailure(null);

    async function create() {
      try {
        const { monaco } = await import('./monaco');
        if (cancelled || !containerRef.current) return;
        const source = monaco.editor.createModel(latest.current.original, 'yaml');
        const draft = monaco.editor.createModel(latest.current.modified, 'yaml');
        try {
          const diff = monaco.editor.createDiffEditor(containerRef.current, {
            theme: 'ss14-dark',
            readOnly: true,
            originalEditable: false,
            renderSideBySide: sideBySide,
            ignoreTrimWhitespace: ignoreWhitespace,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            renderOverviewRuler: true,
            maxComputationTime: 4000,
            renderWhitespace: 'all',
            wordWrap: 'off',
            lineNumbers: 'on',
          });
          diff.setModel({ original: source, modified: draft });
          diffRef.current = diff;
          modelsRef.current = { original: source, modified: draft };
          dispose = () => {
            diffRef.current = null;
            modelsRef.current = null;
            diff.dispose();
            source.dispose();
            draft.dispose();
          };
          if (!cancelled) setLoading(false);
        } catch (error) {
          source.dispose();
          draft.dispose();
          throw error;
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      }
    }

    void create();
    return () => {
      cancelled = true;
      dispose?.();
    };
    // Layout modes are updated without destroying models or scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooLarge]);

  return <section className="yaml-diff" aria-label={'Сравнение изменений: ' + fileLabel}>
    <div className="yaml-diff-toolbar">
      <div className="yaml-diff-labels">
        <span>{originalLabel}</span>
        <span>{modifiedLabel}</span>
      </div>
      <label>
        <input type="checkbox" checked={sideBySide}
          onChange={(event) => setSideBySide(event.target.checked)}/>
        <Columns2 size={13}/> Две колонки
      </label>
      <label>
        <input type="checkbox" checked={ignoreWhitespace}
          onChange={(event) => setIgnoreWhitespace(event.target.checked)}/>
        Игнорировать крайние пробелы
      </label>
    </div>
    {(tooLarge || failure) ? <div className="yaml-diff-fallback">
      <p><AlertTriangle size={14}/>
        {tooLarge
          ? 'Файл слишком большой для встроенного diff. Показаны оба исходных текста без выделения изменений.'
          : 'Monaco diff не загрузился. Исходный текст доступен для копирования.'}
      </p>
      {failure && <details><summary>Технические сведения</summary><pre>{failure}</pre></details>}
      <div className="yaml-diff-fallback-grid">
        <label>{originalLabel}
          <textarea readOnly spellCheck={false} value={original} rows={12}/>
        </label>
        <label>{modifiedLabel}
          <textarea readOnly spellCheck={false} value={modified} rows={12}/>
        </label>
      </div>
    </div> : <div className="yaml-diff-frame">
      <div className="yaml-diff-container" ref={containerRef}
        aria-label={'Различия между ' + originalLabel + ' и ' + modifiedLabel}/>
      {loading && <p className="yaml-diff-loading" role="status">Загрузка сравнения…</p>}
    </div>}
  </section>;
}
