const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');

const rootDirectory = path.resolve(__dirname, '..');
const dataDirectory = path.join(rootDirectory, 'data');
const sourceArchive = path.join(dataDirectory, 'Noto_Sans_JP.zip');
const colorImage = path.join(rootDirectory, '0-color.png');
const distDirectory = path.join(rootDirectory, 'dist');
const readmeFile = path.join(rootDirectory, 'release', 'README.txt');
const licenseFile = path.join(rootDirectory, 'LICENSE');
const colorCopyright = 'Copyright (c) 2026 otoneko. (color modifications)';
const styles = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'];
const fontFiles = [
  { source: 'NotoSansJP-VariableFont_wght.ttf', output: 'NottsuSansJP-VariableFont_wght.ttf' },
  ...styles.map((style) => ({
    source: `static/NotoSansJP-${style}.ttf`,
    output: `static/NottsuSansJP-${style}.ttf`,
    style,
  })),
];
const f2dot14One = 1 << 14;

async function withSourceFonts(useFonts) {
  await fs.access(sourceArchive);
  const directory = await fs.mkdtemp(path.join(dataDirectory, '.noto-source-'));
  try {
    const entries = fontFiles.map(({ source }) => source);
    // Windows ships a ZIP-capable tar; the Linux runner uses unzip.
    const [command, args] = process.platform === 'win32'
      ? ['tar.exe', ['-xf', sourceArchive, '-C', directory, '--', ...entries]]
      : ['unzip', ['-q', sourceArchive, ...entries, '-d', directory]];
    await promisify(execFile)(command, args);
    await useFonts(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const remaining = Math.min(4, bytes.length - offset);
    sum = (sum + bytes.readUIntBE(offset, remaining) * 256 ** (4 - remaining)) >>> 0;
  }
  return sum;
}

function readTables(font, verifyChecksums = false) {
  if (font.length < 12 || font.readUInt32BE(0) !== 0x00010000) {
    throw new Error('Expected a TrueType font (.ttf).');
  }

  const tableCount = font.readUInt16BE(4);
  const directoryEnd = 12 + tableCount * 16;
  if (tableCount === 0 || directoryEnd > font.length) throw new Error('Invalid table directory.');
  const tables = new Map();
  const ranges = [];
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    const tag = font.toString('ascii', record, record + 4);
    const offset = font.readUInt32BE(record + 8);
    const length = font.readUInt32BE(record + 12);
    if (offset < directoryEnd || offset % 4 || offset + length > font.length || tables.has(tag)) {
      throw new Error(`Invalid ${tag} table.`);
    }
    const bytes = font.subarray(offset, offset + length);
    if (verifyChecksums) {
      // The head checksum excludes the checksum adjustment stored in the table itself.
      const adjustment = tag === 'head' ? bytes.readUInt32BE(8) : 0;
      if (((checksum(bytes) - adjustment) >>> 0) !== font.readUInt32BE(record + 4)) {
        throw new Error(`Invalid ${tag} table checksum.`);
      }
    }
    tables.set(tag, bytes);
    if (length) ranges.push([offset, offset + length]);
  }
  ranges.sort(([left], [right]) => left - right);
  if (ranges.some(([start], i) => i > 0 && start < ranges[i - 1][1])) {
    throw new Error('Font tables overlap.');
  }
  if (verifyChecksums && checksum(font) !== 0xb1b0afba) {
    throw new Error('Invalid font checksum.');
  }
  return tables;
}

function writeFont(tables) {
  const tags = [...tables.keys()].sort();
  const directorySize = 12 + tags.length * 16;
  const paddedSize = (size) => Math.ceil(size / 4) * 4;
  const fontSize = tags.reduce((size, tag) => size + paddedSize(tables.get(tag).length), directorySize);
  const font = Buffer.alloc(fontSize);
  const entrySelector = Math.floor(Math.log2(tags.length));
  const searchRange = 16 * 2 ** entrySelector;
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(tags.length, 4);
  font.writeUInt16BE(searchRange, 6);
  font.writeUInt16BE(entrySelector, 8);
  font.writeUInt16BE(tags.length * 16 - searchRange, 10);

  let offset = directorySize;
  let headOffset;
  for (const [index, tag] of tags.entries()) {
    const bytes = tables.get(tag);
    const paddedEnd = offset + paddedSize(bytes.length);
    const record = 12 + index * 16;
    bytes.copy(font, offset);
    if (tag === 'head') {
      headOffset = offset;
      // The head table checksum is computed with checkSumAdjustment set to zero.
      font.writeUInt32BE(0, headOffset + 8);
    }
    font.write(tag, record, 4, 'ascii');
    font.writeUInt32BE(checksum(font.subarray(offset, paddedEnd)), record + 4);
    font.writeUInt32BE(offset, record + 8);
    font.writeUInt32BE(bytes.length, record + 12);
    offset = paddedEnd;
  }
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

function updateFontNames(nameTable) {
  const familyNameIds = new Set([1, 3, 4, 6, 16, 18, 20, 21, 25]);
  const names = Buffer.from(nameTable);
  const storageOffset = names.readUInt16BE(4);
  const strings = [];
  let offset = names.length - storageOffset;
  for (let i = 0; i < names.readUInt16BE(2); i++) {
    const record = 6 + i * 12;
    const nameId = names.readUInt16BE(record + 6);
    if (nameId !== 0 && !familyNameIds.has(nameId) && nameId < 256) continue;
    const platform = names.readUInt16BE(record);
    const start = storageOffset + names.readUInt16BE(record + 10);
    const original = names.subarray(start, start + names.readUInt16BE(record + 8));
    const unicode = platform === 0 || platform === 3;
    const encoding = unicode ? 'utf16le' : 'latin1';
    const name = (unicode ? Buffer.from(original).swap16() : original).toString(encoding);
    const replacement = nameId === 0
      ? `${name}\n${colorCopyright}`
      : name.replaceAll('Noto Sans JP', 'Nottsu Sans JP').replaceAll('NotoSansJP', 'NottsuSansJP');
    if (name === replacement) continue;
    const bytes = Buffer.from(replacement, encoding);
    if (unicode) bytes.swap16();
    // Keep the original string storage so language tags and other name records retain their offsets.
    names.writeUInt16BE(bytes.length, record + 8);
    names.writeUInt16BE(offset, record + 10);
    strings.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat([names, ...strings]);
}

function sampleWeightAxis(axis, avar) {
  if (avar && (avar.readUInt32BE(0) !== 0x00010000 || avar.readUInt16BE(6) !== 1)) {
    throw new Error('Expected a single-axis version 1 avar table.');
  }
  const mapping = avar
    ? Array.from({ length: avar.readUInt16BE(8) }, (_, i) => [avar.readInt16BE(10 + i * 4), avar.readInt16BE(12 + i * 4)])
    : [[-f2dot14One, -f2dot14One], [0, 0], [f2dot14One, f2dot14One]];
  const coordinates = new Map([[0, axis.default]]);
  for (let index = 1; index < mapping.length; index++) {
    const [fromStart, toStart] = mapping[index - 1];
    const [fromEnd, toEnd] = mapping[index];
    const span = fromEnd <= 0 ? axis.default - axis.min : axis.max - axis.default;
    if (span === 0) continue;
    // Sample inside each avar segment so the paint follows changes in the glyph bounds.
    const steps = Math.max(1, Math.ceil((toEnd - toStart) / 512));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const coordinate = Math.round(toStart + (toEnd - toStart) * t);
      const weight = axis.default + span * (fromStart + (fromEnd - fromStart) * t) / f2dot14One;
      coordinates.set(coordinate, weight);
    }
  }
  return [...coordinates].sort(([left], [right]) => left - right);
}

async function readGlyphCenters(source, tables) {
  const { Blob, Face, Font, Variation } = await import('harfbuzzjs');
  const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const face = new Face(new Blob(bytes));
  const axes = face.getAxisInfos();
  if (tables.has('fvar') && (!axes.wght || Object.keys(axes).length !== 1)) {
    throw new Error('Expected a variable Noto Sans JP font with a single wght axis.');
  }
  const coordinates = axes.wght ? sampleWeightAxis(axes.wght, tables.get('avar')) : [];
  const font = new Font(face);
  const glyphCount = tables.get('maxp').readUInt16BE(4);
  const glyphs = [];
  for (let id = 1; id < glyphCount; id++) {
    const bounds = font.glyphExtents(id);
    if (!bounds?.width || !bounds.height) continue;
    const x = Math.round(bounds.xBearing + bounds.width / 2);
    const y = Math.round(bounds.yBearing + bounds.height / 2);
    glyphs.push({ id, x, y, outline: font.glyphToPath(id), xDeltas: [], yDeltas: [] });
  }
  for (const [coordinate, weight] of coordinates) {
    if (coordinate === 0) continue;
    font.setVariations([Variation.fromString(`wght=${weight}`)]);
    for (const glyph of glyphs) {
      const bounds = font.glyphExtents(glyph.id);
      const x = Math.round(bounds.xBearing + bounds.width / 2);
      const y = Math.round(bounds.yBearing + bounds.height / 2);
      glyph.xDeltas.push(x - glyph.x);
      glyph.yDeltas.push(y - glyph.y);
    }
  }
  return { glyphs, coordinates: coordinates.map(([coordinate]) => coordinate) };
}

function makePaletteTable(palette) {
  const colorRecordsOffset = 14;
  const cpal = Buffer.alloc(colorRecordsOffset + palette.length * 4);
  cpal.writeUInt16BE(palette.length, 2);
  cpal.writeUInt16BE(1, 4);
  cpal.writeUInt16BE(palette.length, 6);
  cpal.writeUInt32BE(colorRecordsOffset, 8);
  for (const [index, [r, g, b, a]] of palette.entries()) {
    cpal.set([b, g, r, a], colorRecordsOffset + index * 4);
  }
  return cpal;
}

function makeVariationStore(glyphs, coordinates) {
  const regions = coordinates.flatMap((peak, index) => {
    if (peak === 0) return [];
    return [[coordinates[index - 1] ?? peak, peak, coordinates[index + 1] ?? peak]];
  });
  const regionListOffset = 12;
  const dataOffset = regionListOffset + 4 + regions.length * 6;
  const itemCount = glyphs.length * 2;
  const dataHeaderSize = 6 + regions.length * 2;
  if (itemCount > 0xffff) throw new Error('Too many glyphs for one COLR variation data table.');
  const store = Buffer.alloc(dataOffset + dataHeaderSize + itemCount * regions.length * 2);
  store.writeUInt16BE(1, 0);
  store.writeUInt32BE(regionListOffset, 2);
  store.writeUInt16BE(1, 6);
  store.writeUInt32BE(dataOffset, 8);
  store.writeUInt16BE(1, regionListOffset);
  store.writeUInt16BE(regions.length, regionListOffset + 2);
  for (const [index, [start, peak, end]] of regions.entries()) {
    const offset = regionListOffset + 4 + index * 6;
    store.writeInt16BE(start, offset);
    store.writeInt16BE(peak, offset + 2);
    store.writeInt16BE(end, offset + 4);
    store.writeUInt16BE(index, dataOffset + 6 + index * 2);
  }
  store.writeUInt16BE(itemCount, dataOffset);
  store.writeUInt16BE(regions.length, dataOffset + 2);
  store.writeUInt16BE(regions.length, dataOffset + 4);

  // Adjacent regions crossfade between the sampled center offsets.
  let offset = dataOffset + dataHeaderSize;
  for (const { xDeltas, yDeltas } of glyphs) {
    for (const deltas of [xDeltas, yDeltas]) {
      for (const delta of deltas) {
        store.writeInt16BE(delta, offset);
        offset += 2;
      }
    }
  }
  return store;
}

function makeColorTable(glyphs, stops, coordinates) {
  const baseGlyphListOffset = 34;
  const recordsOffset = baseGlyphListOffset + 4;
  const paintsOffset = recordsOffset + glyphs.length * 6;
  const paintGlyphSize = 6;
  const paintTranslateSize = coordinates.length ? 12 : 0;
  const paintSweepSize = 12;
  const paintSize = paintGlyphSize + paintTranslateSize + paintSweepSize;
  const colorLineOffset = paintsOffset + glyphs.length * paintSize;
  const colr = Buffer.alloc(colorLineOffset + 3 + stops.length * 6);
  colr.writeUInt16BE(1, 0);
  colr.writeUInt32BE(baseGlyphListOffset, 14);
  if (paintTranslateSize) colr.writeUInt32BE(colr.length, 30);
  colr.writeUInt32BE(glyphs.length, baseGlyphListOffset);

  for (const [index, { id, x, y }] of glyphs.entries()) {
    const record = recordsOffset + index * 6;
    const paint = paintsOffset + index * paintSize;
    const translate = paint + paintGlyphSize;
    const sweep = translate + paintTranslateSize;
    colr.writeUInt16BE(id, record);
    colr.writeUInt32BE(paint - baseGlyphListOffset, record + 2);
    colr.writeUInt8(10, paint); // PaintGlyph clips the sweep to the existing outline.
    colr.writeUIntBE(paintGlyphSize, paint + 1, 3);
    colr.writeUInt16BE(id, paint + 4);
    if (paintTranslateSize) {
      // Translate only the color fill as the glyph's outline changes with weight.
      colr.writeUInt8(15, translate);
      colr.writeUIntBE(paintTranslateSize, translate + 1, 3);
      colr.writeUInt32BE(index * 2, translate + 8);
    }
    colr.writeUInt8(8, sweep); // PaintSweepGradient shares one color line across all glyphs.
    colr.writeUIntBE(colorLineOffset - sweep, sweep + 1, 3);
    colr.writeInt16BE(x, sweep + 4);
    colr.writeInt16BE(y, sweep + 6);
    // Sweep angles use (degrees / 180) - 1, so 0° to 360° is stored as -1 to 1.
    colr.writeInt16BE(-f2dot14One, sweep + 8);
    colr.writeInt16BE(f2dot14One, sweep + 10);
  }

  colr.writeUInt16BE(stops.length, colorLineOffset + 1);
  for (const [index, [turn, paletteIndex]] of stops.entries()) {
    const stop = colorLineOffset + 3 + index * 6;
    colr.writeInt16BE(Math.round(turn * f2dot14One), stop);
    colr.writeUInt16BE(paletteIndex, stop + 2);
    colr.writeInt16BE(f2dot14One, stop + 4);
  }
  return paintTranslateSize ? Buffer.concat([colr, makeVariationStore(glyphs, coordinates)]) : colr;
}

// Browsers and platforms without COLR v1 support (such as Safari) fall back
// to the SVG table, so the variable font also carries every color glyph as
// an SVG document: the outline clips one flat sector per sweep color span,
// exactly like the COLR paint but with the default instance's center baked
// in. Documents are stored gzip-compressed, as the SVG table allows.
function makeSvgDocument({ id, x, y, outline }, stops, palette, unitsPerEm) {
  const radius = 4 * unitsPerEm;
  const point = (angle) => `${(x + radius * Math.cos(angle)).toFixed(1)} ${(y + radius * Math.sin(angle)).toFixed(1)}`;
  const sectors = [];
  for (let index = 0; index < stops.length - 1; index++) {
    const [turn, colorIndex] = stops[index];
    const nextTurn = stops[index + 1][0];
    if (turn >= nextTurn) continue;
    const start = turn * 2 * Math.PI;
    const end = nextTurn * 2 * Math.PI;
    const largeArc = Number(end - start > Math.PI);
    const [r, g, b] = palette[colorIndex];
    sectors.push(`<path d="M ${x} ${y} L ${point(start)} A ${radius} ${radius} 0 ${largeArc} 1 ${point(end)} Z" fill="rgb(${r},${g},${b})"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg"><clipPath id="c${id}"><path d="${outline}"/></clipPath><g clip-path="url(#c${id})">${sectors.join('')}</g></svg>`;
}

function makeSvgTable(glyphs, stops, palette, unitsPerEm) {
  const documents = glyphs.map((glyph) => {
    const compressed = zlib.gzipSync(makeSvgDocument(glyph, stops, palette, unitsPerEm));
    compressed.writeUInt32BE(0, 4); // Keep builds reproducible: no gzip timestamp.
    return compressed;
  });
  const indexOffset = 10;
  const entriesSize = 2 + documents.length * 12;
  const table = Buffer.alloc(indexOffset + entriesSize + documents.reduce((size, document) => size + document.length, 0));
  table.writeUInt16BE(0, 0);
  table.writeUInt32BE(indexOffset, 2);
  table.writeUInt16BE(documents.length, indexOffset);
  let offset = entriesSize;
  for (const [index, glyph] of glyphs.entries()) {
    const entry = indexOffset + 2 + index * 12;
    table.writeUInt16BE(glyph.id, entry);
    table.writeUInt16BE(glyph.id, entry + 2);
    table.writeUInt32BE(offset, entry + 4);
    table.writeUInt32BE(documents[index].length, entry + 8);
    documents[index].copy(table, indexOffset + offset);
    offset += documents[index].length;
  }
  return table;
}

async function readSweepColors() {
  const { data, info } = await sharp(colorImage)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const samples = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = data.readUInt32BE((y * width + x) * channels);
      // The image's y-axis points down, but COLR sweep angles run counterclockwise.
      const angle = Math.atan2(height / 2 - y, x - width / 2);
      const turn = (angle / (2 * Math.PI) + 1) % 1;
      samples.push({ color, turn });
    }
  }
  samples.sort((a, b) => a.turn - b.turn);

  const colors = [...new Set(samples.map(({ color }) => color))];
  const transitions = [];
  for (const [index, current] of samples.entries()) {
    const next = samples[(index + 1) % samples.length];
    if (current.color === next.color) continue;
    // Place the boundary between the two nearest sampled angles, unwrapping at 0°.
    const nextTurn = next.turn < current.turn ? next.turn + 1 : next.turn;
    const turn = ((current.turn + nextTurn) / 2) % 1;
    transitions.push({ turn, from: current.color, to: next.color });
  }
  transitions.sort((a, b) => a.turn - b.turn);

  if (colors.length !== 4 || transitions.length !== 4 || colors.some((color) => (color & 255) !== 255)) {
    throw new Error('0-color.png must have four opaque sectors meeting at the center.');
  }

  const palette = colors.map((color) => [color >>> 24, (color >>> 16) & 255, (color >>> 8) & 255, color & 255]);
  const seamColor = colors.indexOf(transitions.at(-1).to);
  const stops = [[0, seamColor]];
  for (const { turn, from, to } of transitions) {
    // Two stops at one angle switch colors immediately, with no blend between sectors.
    stops.push([turn, colors.indexOf(from)], [turn, colors.indexOf(to)]);
  }
  stops.push([1, seamColor]);
  return { palette, stops };
}

async function buildFont(source, output, { palette, stops }, { svg = false } = {}) {
  const sourceFile = await fs.stat(source);
  const outputFile = await fs.stat(output).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (outputFile && sourceFile.dev === outputFile.dev && sourceFile.ino === outputFile.ino) {
    throw new Error('The output path must differ from the source font path.');
  }

  const sourceFont = await fs.readFile(source);
  const tables = readTables(sourceFont, true);
  const { glyphs, coordinates } = await readGlyphCenters(sourceFont, tables);
  if (glyphs.length === 0) throw new Error('The source font has no visible glyphs.');
  tables.set('name', updateFontNames(tables.get('name')));
  tables.set('CPAL', makePaletteTable(palette));
  tables.set('COLR', makeColorTable(glyphs, stops, coordinates));
  if (svg) tables.set('SVG ', makeSvgTable(glyphs, stops, palette, tables.get('head').readUInt16BE(18)));
  tables.delete('DSIG'); // The original signature cannot verify the modified font.

  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, writeFont(tables));
  console.log(`Wrote ${glyphs.length.toLocaleString('en-US')} color glyphs to ${path.relative(process.cwd(), output)}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    console.log('Usage: node scripts/build.js');
    console.log('Build the complete release package in dist/ from data/Noto_Sans_JP.zip.');
    process.exitCode = args[0] === '--help' && args.length === 1 ? 0 : 1;
    return;
  }

  const colors = await readSweepColors();
  await Promise.all([licenseFile, readmeFile].map((filename) => fs.access(filename)));
  await withSourceFonts(async (sourceDirectory) => {
    for (const { source, output, style } of fontFiles) {
      // Only the variable font carries the SVG table: the static fonts
      // would each grow by roughly the same amount again.
      await buildFont(path.join(sourceDirectory, source), path.join(distDirectory, output), colors, { svg: style === undefined });
    }
  });
  await Promise.all([
    fs.copyFile(licenseFile, path.join(distDirectory, 'OFL.txt')),
    fs.copyFile(readmeFile, path.join(distDirectory, 'README.txt')),
    fs.cp(path.join(rootDirectory, 'examples'), path.join(distDirectory, 'examples'), { recursive: true }),
  ]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { withSourceFonts, distDirectory, readmeFile, licenseFile, fontFiles, readTables, readSweepColors, updateFontNames };
