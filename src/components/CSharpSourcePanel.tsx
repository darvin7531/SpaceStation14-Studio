import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, FileCode2, X } from 'lucide-react';
import { studio, type ResourceDocument } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';

interface Props {
  path: string;
  line: number;
  onBack: () => void;
  onClose: () => void;
}

const WINDOW_LINES = 120;

/** Bounded source viewer: no writes and only 120 rendered code lines at a time. */
export default function CSharpSourcePanel({ path, line, onBack, onClose }: Props) {
  const [document, setDocument] = useState<ResourceDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(Math.max(1, line - 35));

  useEffect(() => {
    let active = true;
    void studio.readCSharpSource(path).then((loaded) => {
      if (!active) return;
      setDocument(loaded);
      setError(null);
    }).catch((failure: unknown) => {
      if (!active) return;
      const explained = normalizeStudioError(failure);
      setError(explained.message + ' ' + explained.hint);
    });
    return () => { active = false; };
  }, [path]);

  const lines = useMemo(() => document?.content.split(/\r?\n/) ?? [], [document]);
  const last = Math.min(lines.length, start + WINDOW_LINES - 1);

  return <div className="csharp-catalog-backdrop">
    <section className="csharp-catalog-modal csharp-source-modal" role="dialog"
      aria-modal="true" aria-labelledby="csharp-source-heading"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onBack(); } }}>
      <header>
        <div><small>Только чтение · исходник в открытом проекте</small>
          <h2 id="csharp-source-heading"><FileCode2 size={17}/> {path}</h2>
        </div>
        <div>
          <button type="button" onClick={onBack} aria-label="Назад к C# каталогу">
            <ArrowLeft size={17}/> Назад
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть C# просмотр"><X size={18}/></button>
        </div>
      </header>
      <div className="csharp-source-notice">
        Строка объявления в индексе: {line}. Показывается текущий файл с диска; после внешних правок номер строки может измениться.
      </div>
      {error && <p role="alert" className="csharp-source-error">{error}</p>}
      {!document && !error && <p role="status" className="csharp-source-loading">Читаю исходник C#…</p>}
      {document && <div className="csharp-source-lines" aria-label="Текст исходника C#">
        {lines.slice(start - 1, last).map((text, i) =>
          <div key={start + i} className={'csharp-source-line' + (start + i === line ? ' target' : '')}>
            <span aria-hidden="true">{start + i}</span><code>{text || ' '}</code>
          </div>)}
      </div>}
      <footer>
        <small>{document ? `Строки ${start}–${last} из ${lines.length} · ${Math.round(document.bytes / 1024)} КиБ` : 'Просмотр C#'}</small>
        <div>
          <button type="button" disabled={!document || start <= 1}
            onClick={() => setStart(Math.max(1, start - WINDOW_LINES))}>
            <ChevronUp size={14}/> Ранее
          </button>
          <button type="button" disabled={!document || last >= lines.length}
            onClick={() => setStart(start + WINDOW_LINES)}>
            <ChevronDown size={14}/> Далее
          </button>
          <button type="button" disabled={!document} onClick={() => setStart(Math.max(1, line - 35))}>
            К объявлению
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
