/**
 * A QR encoder, because the big screen's lobby needs one and the clients have
 * no dependencies.
 *
 * Deliberately small: byte mode, error correction level M, versions 1–4. That
 * covers 62 bytes, which is every join URL this product will ever print
 * (`https://quorum.example.com/j/RAFT` is 33). Anything longer returns `null`
 * and the screen falls back to the URL in mono, which is what a person in the
 * room would read anyway.
 *
 * Level M, not L: the screen is seen through video compression, and the extra
 * redundancy is cheaper than a QR code nobody can scan.
 */

const EC_LEVEL_M_BITS = 0b00;

/** version → [total codewords, EC codewords per block, blocks] at level M. */
const VERSIONS: readonly (readonly [number, number, number])[] = [
  [26, 10, 1], // v1: 16 data codewords
  [44, 16, 1], // v2: 28
  [70, 26, 1], // v3: 44
  [100, 18, 2], // v4: 64
];

const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
];

export interface QrCode {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

export function encodeQr(text: string): QrCode | null {
  const data = new TextEncoder().encode(text);

  for (let v = 1; v <= VERSIONS.length; v++) {
    const spec = VERSIONS[v - 1];
    if (!spec) break;
    const [total, ecPerBlock, blocks] = spec;
    const dataCodewords = total - ecPerBlock * blocks;
    // 4 bits mode + 8 bits count + payload, rounded up to whole codewords.
    if (Math.ceil((4 + 8 + data.length * 8) / 8) > dataCodewords) continue;
    return build(v, data, total, ecPerBlock, blocks, dataCodewords);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Bitstream                                                           */
/* ------------------------------------------------------------------ */

function build(
  version: number,
  data: Uint8Array,
  total: number,
  ecPerBlock: number,
  blocks: number,
  dataCodewords: number,
): QrCode {
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(data.length, 8); // character count, 8 bits for versions 1–9
  for (const b of data) push(b, 8);

  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < dataCodewords; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }

  /* Split into blocks, compute Reed-Solomon, interleave. */
  const shortBlockLen = Math.floor(dataCodewords / blocks);
  const numLong = dataCodewords % blocks;
  const divisor = rsDivisor(ecPerBlock);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortBlockLen + (b >= blocks - numLong ? 1 : 0);
    const block = codewords.slice(at, at + len);
    at += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }

  const interleaved: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      const c = block[i];
      if (c !== undefined) interleaved.push(c);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      const c = block[i];
      if (c !== undefined) interleaved.push(c);
    }
  }
  if (interleaved.length !== total) {
    throw new Error(`qr: ${interleaved.length} codewords, expected ${total}`);
  }

  return layout(version, interleaved);
}

/* ------------------------------------------------------------------ */
/* GF(256) — polynomial 0x11D                                          */
/* ------------------------------------------------------------------ */

function gfMul(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Matrix                                                              */
/* ------------------------------------------------------------------ */

function layout(version: number, codewords: readonly number[]): QrCode {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const setFn = (row: number, col: number, dark: boolean): void => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    const r = modules[row];
    const f = isFunction[row];
    if (!r || !f) return;
    r[col] = dark;
    f[col] = true;
  };

  // Timing
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Finders, with their separators (the `dist` trick draws both)
  for (const [r, c] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ] as const) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        setFn(r + dr, c + dc, dist !== 2 && dist !== 4);
      }
    }
  }

  // Alignment, except where a finder already is
  const centres = ALIGNMENT[version - 1] ?? [];
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centres.length - 1) ||
        (i === centres.length - 1 && j === 0)
      ) {
        continue;
      }
      const r = centres[i];
      const c = centres[j];
      if (r === undefined || c === undefined) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas so the data placement steps over them.
  drawFormat(setFn, size, 0);

  /* Data, in the zigzag from the bottom right. */
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not a column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunction[row]?.[col] === true || bitIndex >= totalBits) continue;
        const cw = codewords[bitIndex >>> 3] ?? 0;
        const target = modules[row];
        if (target) target[col] = ((cw >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }

  /* Pick the mask by penalty, as the spec says to. */
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, mask);
    drawFormat(setFn, size, mask);
    const p = penalty(modules, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      best = mask;
    }
    applyMask(modules, isFunction, mask); // XOR is its own inverse
  }
  applyMask(modules, isFunction, best);
  drawFormat(setFn, size, best);

  return { size, modules };
}

type SetFn = (row: number, col: number, dark: boolean) => void;

function drawFormat(setFn: SetFn, size: number, mask: number): void {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFn(i, 8, bit(i));
  setFn(7, 8, bit(6));
  setFn(8, 8, bit(7));
  setFn(8, 7, bit(8));
  for (let i = 9; i < 15; i++) setFn(8, 14 - i, bit(i));

  for (let i = 0; i < 8; i++) setFn(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) setFn(size - 15 + i, 8, bit(i));
  setFn(size - 8, 8, true); // always dark
}

function applyMask(
  modules: boolean[][],
  isFunction: readonly (readonly boolean[])[],
  mask: number,
): void {
  const size = modules.length;
  for (let row = 0; row < size; row++) {
    const r = modules[row];
    const f = isFunction[row];
    if (!r || !f) continue;
    for (let col = 0; col < size; col++) {
      if (f[col]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (col + row) % 2 === 0; break;
        case 1: invert = row % 2 === 0; break;
        case 2: invert = col % 3 === 0; break;
        case 3: invert = (col + row) % 3 === 0; break;
        case 4: invert = (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0; break;
        case 5: invert = ((col * row) % 2) + ((col * row) % 3) === 0; break;
        case 6: invert = (((col * row) % 2) + ((col * row) % 3)) % 2 === 0; break;
        default: invert = (((col + row) % 2) + ((col * row) % 3)) % 2 === 0; break;
      }
      if (invert) r[col] = !r[col];
    }
  }
}

function penalty(modules: readonly (readonly boolean[])[], size: number): number {
  let score = 0;
  const at = (r: number, c: number): boolean => modules[r]?.[c] === true;

  // Rule 1: runs of five or more
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let runColour = false;
      let runLength = 0;
      for (let b = 0; b < size; b++) {
        const dark = axis === 0 ? at(a, b) : at(b, a);
        if (dark === runColour) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColour = dark;
          runLength = 1;
        }
      }
    }
  }

  // Rule 2: 2×2 blocks of one colour
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-lookalike pattern
  const pattern = [true, false, true, true, true, false, true];
  const run = (get: (i: number) => boolean, len: number): void => {
    for (let i = 0; i + 7 <= len; i++) {
      let hit = true;
      for (let k = 0; k < 7; k++) {
        if (get(i + k) !== pattern[k]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      const before = i - 4 < 0 || allLight(get, i - 4, 4);
      const after = i + 11 > len || allLight(get, i + 7, 4);
      if (before || after) score += 40;
    }
  };
  for (let a = 0; a < size; a++) {
    run((i) => at(a, i), size);
    run((i) => at(i, a), size);
  }

  // Rule 4: deviation from half dark
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  }
  const totalModules = size * size;
  const k = Math.floor((Math.abs(dark * 20 - totalModules * 10) * 10) / totalModules);
  score += k * 10;
  return score;
}

function allLight(get: (i: number) => boolean, from: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (get(from + i)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Renders onto a canvas at a whole number of device pixels per module. A QR
 * code with fractional module edges is a QR code a phone camera has to work
 * at, and this one is being photographed off a compressed video tile.
 */
export function drawQr(
  canvas: HTMLCanvasElement,
  code: QrCode,
  opts: { targetPx: number; quiet?: number; dark?: string; light?: string },
): void {
  const quiet = opts.quiet ?? 4;
  const modules = code.size + quiet * 2;
  const scale = Math.max(1, Math.floor(opts.targetPx / modules));
  const px = modules * scale;

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = opts.light ?? "#F6F5F3";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = opts.dark ?? "#0A0A0F";
  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (code.modules[r]?.[c] !== true) continue;
      ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}
