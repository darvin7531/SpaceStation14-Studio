/** Electron parity: multiple PNG files dropped onto one RSI.
 * Preflight every file before invoking any native mutation. The Rust importer
 * remains responsible for CRC, PNG decoding checks, revisions and disk writes.
 */
export interface BatchPng {
  name: string;
  bytes: number;
  width: number;
  height: number;
}
export interface BatchEntry {
  name: string;
  directions: 1 | 4 | 8;
  frames: number;
}

const MAX_FILES = 16;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export function pngHeaderSize(header: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (header.byteLength < 24 || !signature.every((byte, i) => header[i] === byte)
    || header[12] !== 73 || header[13] !== 72 || header[14] !== 68 || header[15] !== 82
    || header[8] !== 0 || header[9] !== 0 || header[10] !== 0 || header[11] !== 13) return null;
  const size = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = size.getUint32(16, false);
  const height = size.getUint32(20, false);
  if (!width || !height || width > 16384 || height > 16384) return null;
  return { width, height };
}

export function planRsiBatch(
  files: readonly BatchPng[],
  cell: { x: number; y: number },
  directions: 1 | 4 | 8,
  existingNames: ReadonlySet<string>,
): BatchEntry[] {
  if (!Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y) ||
    cell.x < 1 || cell.y < 1 || cell.x > 2048 || cell.y > 2048) {
    throw new Error('Размер кадра RSI отсутствует или некорректен в meta.json.');
  }
  if (!files.length || files.length > MAX_FILES) {
    throw new Error('Выберите от 1 до 16 PNG для одного пакетного импорта.');
  }
  if (![1, 4, 8].includes(directions)) throw new Error('Направлений должно быть 1, 4 или 8.');
  const names = new Set(existingNames);
  let bytes = 0;
  return files.map((file) => {
    if (file.bytes < 1 || file.bytes > MAX_FILE_BYTES) {
      throw new Error(file.name + ': файл должен быть непустым PNG размером не более 8 МиБ.');
    }
    bytes += file.bytes;
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Суммарный размер выбранных PNG превышает 32 МиБ.');
    if (!/^[a-z0-9_-]{1,128}\.png$/.test(file.name)) {
      throw new Error(file.name + ': имя PNG должно иметь вид state.png (латинские строчные буквы, цифры, - и _).');
    }
    const name = file.name.slice(0, -4);
    if (names.has(name)) throw new Error('Состояние "' + name + '" уже существует или повторяется в списке.');
    names.add(name);
    if (!Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height) ||
      file.width < 1 || file.height < 1 ||
      file.width % cell.x !== 0 || file.height % cell.y !== 0) {
      throw new Error(file.name + ': размер PNG не кратен размеру кадра ' + cell.x + '×' + cell.y + '.');
    }
    const framesTotal = (file.width / cell.x) * (file.height / cell.y);
    if (framesTotal < 1 || framesTotal > 256 || framesTotal % directions !== 0 ||
      framesTotal / directions > 128) {
      throw new Error(file.name + ': сетка кадров не соответствует выбранным направлениям 1/4/8.');
    }
    return { name, directions, frames: framesTotal / directions };
  });
}
