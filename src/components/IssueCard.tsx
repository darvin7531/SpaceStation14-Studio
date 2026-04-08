import { MouseEvent } from 'react';
import { ValidationIssue } from '../types';
import { navigateToIssue, openPrototypeByKey, openRsiByPath } from '../services/navigation';
import { useI18n } from '../i18n';

interface Props {
  issue: ValidationIssue;
  compact?: boolean;
}

export default function IssueCard({ issue, compact = false }: Props) {
  const { t } = useI18n();
  const canOpenPrototype = Boolean(issue.prototypeKey);
  const canOpenRsi = Boolean(issue.rsiPath);

  const onCardClick = () => {
    void navigateToIssue(issue);
  };

  const onPrototypeClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!issue.prototypeKey) return;
    void openPrototypeByKey(issue.prototypeKey, issue.field);
  };

  const onRsiClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!issue.rsiPath) return;
    void openRsiByPath(issue.rsiPath, issue.stateName);
  };

  return (
    <button
      onClick={onCardClick}
      className={`w-full text-left rounded border border-neutral-800 bg-neutral-900 transition-colors hover:bg-neutral-800 ${compact ? 'p-2' : 'p-3'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div>
            <span className={issue.level === 'error' ? 'text-red-400' : issue.level === 'warning' ? 'text-yellow-400' : 'text-blue-400'}>
              {t(`issue.${issue.level}`)}
            </span>
            <span className="text-neutral-500"> / {issue.field ?? t('issue.defaultField')}</span>
          </div>
          <div className="mt-1 text-neutral-300">{issue.message}</div>
        </div>
        {(canOpenPrototype || canOpenRsi) && (
          <div className="flex shrink-0 gap-2">
            {canOpenPrototype && (
              <button onClick={onPrototypeClick} className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700">
                {t('issue.prototype')}
              </button>
            )}
            {canOpenRsi && (
              <button onClick={onRsiClick} className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700">
                {t('issue.rsi')}
              </button>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
