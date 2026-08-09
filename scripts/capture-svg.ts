/**
 * Render captured terminal output to SVG.
 *
 * The screenshots in the README have to be real output from real commands, so
 * this takes a raw capture (ANSI escapes intact) and typesets it. Nothing is
 * hand-written: if the tool changes, the capture changes.
 *
 * No dependencies. SVG is text, and GitHub renders it inline.
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface Style {
  color: string;
  bold: boolean;
  dim: boolean;
}

const PALETTE: Record<string, string> = {
  '30': '#3b4048',
  '31': '#e06c75',
  '32': '#98c379',
  '33': '#e5c07b',
  '34': '#61afef',
  '35': '#c678dd',
  '36': '#56b6c2',
  '37': '#dcdfe4',
};

const FG = '#dcdfe4';
const BG = '#1e2127';
const CHAR_W = 8.4;
const LINE_H = 20;
const PAD = 22;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A carriage return means the terminal redrew the line in place, so only the
 * final segment was ever visible to a human.
 */
function applyCarriageReturns(line: string): string {
  const parts = line.split('\r');
  return parts[parts.length - 1] ?? '';
}

interface Span {
  text: string;
  style: Style;
}

function parseLine(line: string, carried: Style): { spans: Span[]; endStyle: Style } {
  const spans: Span[] = [];
  let style: Style = { ...carried };
  let buf = '';

  const push = (): void => {
    if (buf.length > 0) {
      spans.push({ text: buf, style: { ...style } });
      buf = '';
    }
  };

  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    buf += line.slice(last, m.index);
    push();
    last = m.index + m[0].length;

    for (const codeRaw of (m[1] ?? '0').split(';')) {
      const code = codeRaw === '' ? '0' : codeRaw;
      if (code === '0') style = { color: FG, bold: false, dim: false };
      else if (code === '1') style.bold = true;
      else if (code === '2') style.dim = true;
      else if (code === '22') { style.bold = false; style.dim = false; }
      else if (PALETTE[code]) style.color = PALETTE[code]!;
    }
  }

  buf += line.slice(last);
  push();

  return { spans, endStyle: style };
}

/**
 * `minHeight` and `minWidth` pad the frame so two captures placed side by side
 * in a README line up. Without it, a 262px shot next to a 362px one reads as a
 * broken grid.
 */
export function renderSvg(
  raw: string,
  title: string,
  opts: { minHeight?: number; minWidth?: number } = {},
): string {
  const lines = raw
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split('\n')
    .map(applyCarriageReturns);

  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  const widest = lines.reduce((n, l) => {
    const visible = l.replace(/\x1b\[[0-9;]*m/g, '').length;
    return Math.max(n, visible);
  }, title.length + 6);

  const width = Math.max(opts.minWidth ?? 0, Math.ceil(widest * CHAR_W + PAD * 2));
  const chromeH = 38;
  const height = Math.max(
    opts.minHeight ?? 0,
    Math.ceil(lines.length * LINE_H + PAD * 2 + chromeH),
  );

  const body: string[] = [];
  let carried: Style = { color: FG, bold: false, dim: false };

  lines.forEach((line, i) => {
    const { spans, endStyle } = parseLine(line, carried);
    carried = endStyle;

    const y = PAD + chromeH + i * LINE_H + 14;
    let col = 0;
    const parts: string[] = [];

    for (const span of spans) {
      const x = PAD + col * CHAR_W;
      col += span.text.length;
      if (span.text.trim() === '') continue;

      const weight = span.style.bold ? ' font-weight="600"' : '';
      const opacity = span.style.dim ? ' opacity="0.55"' : '';
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y}" fill="${span.style.color}"${weight}${opacity}>${escapeXml(span.text)}</text>`,
      );
    }

    if (parts.length > 0) body.push(parts.join(''));
  });

  const dots = ['#ff5f57', '#febc2e', '#28c840']
    .map((c, i) => `<circle cx="${20 + i * 18}" cy="20" r="6" fill="${c}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
  <rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
  <rect width="${width}" height="${chromeH}" rx="10" fill="#282c34"/>
  <rect y="${chromeH - 10}" width="${width}" height="10" fill="#282c34"/>
  ${dots}
  <text x="${width / 2}" y="25" fill="#8b92a0" font-size="12" text-anchor="middle">${escapeXml(title)}</text>
  ${body.join('\n  ')}
</svg>
`;
}

const argv = process.argv.slice(2);

function flag(name: string): number | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined ? undefined : Number(v);
}

const minHeight = flag('--min-height');
const minWidth = flag('--min-width');

// Drop flags and the values that follow them, leaving input, output, title.
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'),
);

const [inPath, outPath, ...titleParts] = positional;
if (!inPath || !outPath) {
  console.error(
    'usage: capture-svg.ts <input> <output.svg> [title] [--min-height N] [--min-width N]',
  );
  process.exit(2);
}

writeFileSync(
  outPath,
  renderSvg(readFileSync(inPath, 'utf8'), titleParts.join(' ') || 'rewind', {
    minHeight,
    minWidth,
  }),
);
console.log(`wrote ${outPath}`);
