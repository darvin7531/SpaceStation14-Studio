export async function saveAndClose(request: {
  current: () => boolean;
  save: () => Promise<void>;
  cleanup: () => Promise<void>;
  close: () => void;
}): Promise<void> {
  const check = () => { if (!request.current()) throw new Error('Документ или проект изменился во время сохранения.'); };
  check();
  await request.save();
  check();
  await request.cleanup();
  check();
  request.close();
}
