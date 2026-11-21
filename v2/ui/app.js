import { normalizeStudioError } from './error-utils.mjs';

const form = document.getElementById('project-form');
const folderInput = document.getElementById('project-path');
const openButton = document.getElementById('open-button');
const status = document.getElementById('status');
const result = document.getElementById('result');
const errorPanel = document.getElementById('error-panel');

function setBusy(busy) {
  openButton.disabled = busy;
  folderInput.disabled = busy;
  openButton.textContent = busy ? 'Проверяю…' : 'Открыть проект';
  status.textContent = busy ? 'Проверка папок проекта…' : 'Готово к работе';
}

function showError(source) {
  const error = normalizeStudioError(source);
  result.hidden = true;
  errorPanel.hidden = false;
  document.getElementById('error-message').textContent = error.message;
  document.getElementById('error-hint').textContent = error.hint;
  document.getElementById('error-code').textContent = error.code;
  const detailsNode = document.getElementById('error-details');
  detailsNode.textContent = error.details || 'Дополнительные сведения отсутствуют.';
}

function showResult(project) {
  errorPanel.hidden = true;
  result.hidden = false;
  document.getElementById('project-root').textContent = project.project_root;
  document.getElementById('prototype-files').textContent = String(project.prototype_files);
  document.getElementById('rsi-directories').textContent = String(project.rsi_directories);
  document.getElementById('locale-files').textContent = String(project.locale_files);

  const warnings = document.getElementById('warnings');
  warnings.replaceChildren();
  warnings.hidden = !project.warnings?.length;
  for (const warning of project.warnings || []) {
    const item = document.createElement('li');
    item.textContent = warning;
    warnings.append(item);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const path = folderInput.value.trim();
  setBusy(true);
  errorPanel.hidden = true;
  result.hidden = true;

  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) {
      showError({
        code: 'TAURI_UNAVAILABLE',
        message: 'Нативное ядро приложения недоступно.',
        hint: 'Откройте Studio через Tauri, а не непосредственно в браузере.',
      });
      return;
    }

    const project = await invoke('inspect_project', { path });
    showResult(project);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});
