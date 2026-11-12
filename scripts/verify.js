const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { withSourceFonts, distDirectory, readmeFile, licenseFile, fontFiles, readTables, readSweepColors, updateFontNames } = require('./build');

async function checkFiles(directory, expected) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    assert(entry.name === 'static' || entry.name === 'examples' ? entry.isDirectory() : entry.isFile(), `Invalid entry: ${entry.name}`);
  }
  assert.deepEqual(entries.map(({ name }) => name).sort(), expected.toSorted(), `Unexpected or missing files in ${directory}`);
}

async function checkExamples(directory) {
  const sourceDirectory = path.resolve(__dirname, '..', 'examples', 'js-rendering');
  const outputDirectory = path.join(directory, 'examples', 'js-rendering');
  const [sourceFiles, outputFiles] = await Promise.all([
    fs.readdir(sourceDirectory),
    fs.readdir(outputDirectory),
  ]);
  assert.deepEqual(outputFiles.sort(), sourceFiles.sort(), 'Unexpected or missing files in dist/examples/js-rendering');
  for (const name of sourceFiles) {
    const [expected, actual] = await Promise.all([
      fs.readFile(path.join(sourceDirectory, name)),
      fs.readFile(path.join(outputDirectory, name)),
    ]);
    assert(expected.length > 0 && actual.equals(expected), `Invalid example file: ${name}`);
  }
}

function checkTables(source, output, withSvg) {
  assert(source.has('head') && source.has('maxp') && source.has('glyf'), 'Required TrueType tables are missing');
  const expectedTags = [...source.keys()].filter((tag) => tag !== 'DSIG');
  const addedTags = withSvg ? ['COLR', 'CPAL', 'SVG '] : ['COLR', 'CPAL'];
  assert.deepEqual([...output.keys()].sort(), [...expectedTags, ...addedTags].sort(), 'Unexpected or missing font tables');
  for (const tag of expectedTags) {
    const original = source.get(tag);
    const actual = output.get(tag);
    if (tag === 'head') {
      assert(actual.subarray(0, 8).equals(original.subarray(0, 8)) && actual.subarray(12).equals(original.subarray(12)), 'Changed head metadata');
    } else {
      const expected = tag === 'name' ? updateFontNames(original) : original;
      assert(actual.equals(expected), `Unexpected change to ${tag}`);
    }
  }
  assert.equal(output.get('COLR').readUInt16BE(0), 1, 'Expected COLR v1');
}

function checkPaint(hb, bytes, tables, style, { palette, stops }) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const face = new hb.Face(new hb.Blob(data));
  assert(face.hasColorPaint() && face.hasColorPalettes(), 'HarfBuzz could not read the color tables');
  const axes = face.getAxisInfos();
  if (style === undefined) {
    assert.deepEqual(Object.keys(axes), ['wght']);
    assert.equal(axes.wght.min, 100);
    assert.equal(axes.wght.max, 900);
  } else {
    assert.deepEqual(Object.keys(axes), [], 'Expected a static font');
    assert.equal(face.getName(6, 'en'), `NottsuSansJP-${style}`, 'Unexpected static style');
  }

  const font = new hb.Font(face);
  const paint = new hb.PaintFuncs();
  const expectedStops = stops.map(([offset, index]) => [Math.round(offset * 16384) / 16384, ...palette[index]]);
  const translations = [];
  let clip;
  let sweep;
  paint.setPushTransformFunc((xx, yx, xy, yy, dx, dy) => {
    assert(xx === 1 && yx === 0 && xy === 0 && yy === 1, 'Unexpected paint transform');
    translations.push([dx, dy]);
  });
  paint.setPopTransformFunc(() => translations.pop());
  paint.setPushClipGlyphFunc((id) => { clip = id; });
  paint.setSweepGradientFunc((line, x, y, start, end) => {
    assert.equal(line.colorStops.length, expectedStops.length, 'Missing color stops');
    assert(Math.abs(start) < 1e-5 && Math.abs(end - 2 * Math.PI) < 1e-5, 'Invalid sweep angles');
    for (const [index, { offset, isForeground, color }] of line.colorStops.entries()) {
      const [expectedOffset, r, g, b, a] = expectedStops[index];
      assert(!isForeground && offset === expectedOffset && color.red === r && color.green === g && color.blue === b && color.alpha === a, 'Invalid sweep color stop');
    }
    sweep = translations.reduce(([cx, cy], [dx, dy]) => [cx + dx, cy + dy], [x, y]);
  });

  const glyphCount = tables.get('maxp').readUInt16BE(4);
  const weights = style === undefined ? [axes.wght.default, 400, 650, 900] : [tables.get('OS/2').readUInt16BE(4)];
  for (const currentWeight of new Set(weights)) {
    if (axes.wght) font.setVariations([hb.Variation.fromString(`wght=${currentWeight}`)]);
    let painted = 0;
    for (let id = 1; id < glyphCount; id++) {
      const bounds = font.glyphExtents(id);
      if (!bounds?.width || !bounds.height) continue;
      clip = undefined;
      sweep = undefined;
      assert(font.paintGlyphOrFail(id, paint) && sweep && clip === id, `Missing paint or outline for glyph ${id} at weight ${currentWeight}`);
      const centerX = bounds.xBearing + bounds.width / 2;
      const centerY = bounds.yBearing + bounds.height / 2;
      // The variable paint interpolates between sampled centers in whole font units.
      const tolerance = axes.wght && currentWeight !== axes.wght.default ? 4 : 0.5;
      assert(Math.abs(sweep[0] - centerX) <= tolerance && Math.abs(sweep[1] - centerY) <= tolerance, `Incorrect color center for glyph ${id} at weight ${currentWeight}`);
      painted++;
    }
    assert(painted > 0, 'No visible glyphs were checked');
  }
}

function checkSvg(hb, bytes, tables, { palette, stops }) {
  const svg = tables.get('SVG ');
  assert(svg, 'Missing SVG table');
  assert.equal(svg.readUInt16BE(0), 0, 'Expected SVG table version 0');
  const indexOffset = svg.readUInt32BE(2);
  const count = svg.readUInt16BE(indexOffset);
  const documents = new Map();
  for (let index = 0; index < count; index++) {
    const entry = indexOffset + 2 + index * 12;
    const startGlyph = svg.readUInt16BE(entry);
    const endGlyph = svg.readUInt16BE(entry + 2);
    const offset = indexOffset + svg.readUInt32BE(entry + 4);
    const length = svg.readUInt32BE(entry + 8);
    const stored = svg.subarray(offset, offset + length);
    assert(stored[0] === 0x1f && stored[1] === 0x8b, 'SVG documents must be gzip compressed');
    const document = zlib.gunzipSync(stored).toString('utf8');
    for (let id = startGlyph; id <= endGlyph; id++) documents.set(id, document);
  }

  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const font = new hb.Font(new hb.Face(new hb.Blob(data)));
  const glyphCount = tables.get('maxp').readUInt16BE(4);
  const sectorCount = stops.filter(([turn], index) => index + 1 < stops.length && turn < stops[index + 1][0]).length;
  for (let id = 1; id < glyphCount; id++) {
    const bounds = font.glyphExtents(id);
    if (!bounds?.width || !bounds.height) continue;
    const document = documents.get(id);
    assert(document, `Missing SVG document for glyph ${id}`);
    assert(document.includes(`<clipPath id="c${id}">`), `SVG document for glyph ${id} does not clip to its outline`);
    assert.equal(document.split('<path').length - 1, sectorCount + 1, `Unexpected path count in SVG document for glyph ${id}`);
    for (const [r, g, b] of palette) {
      assert(document.includes(`fill="rgb(${r},${g},${b})"`), `SVG document for glyph ${id} is missing a palette color`);
    }
  }
}

async function main() {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : distDirectory;
  const staticFiles = fontFiles.filter(({ style }) => style !== undefined);
  await checkFiles(directory, [fontFiles[0].output, 'OFL.txt', 'README.txt', 'static', 'examples']);
  await checkExamples(directory);
  await checkFiles(path.join(directory, 'static'), staticFiles.map(({ output }) => path.basename(output)));
  for (const [name, original] of [['OFL.txt', licenseFile], ['README.txt', readmeFile]]) {
    const [expected, actual] = await Promise.all([fs.readFile(original), fs.readFile(path.join(directory, name))]);
    assert(expected.length > 0 && actual.equals(expected), `Invalid ${name}`);
  }

  const [hb, colors] = await Promise.all([import('harfbuzzjs'), readSweepColors()]);
  await withSourceFonts(async (sourceDirectory) => {
    for (const { source, output, style } of fontFiles) {
      try {
        const [original, bytes] = await Promise.all([fs.readFile(path.join(sourceDirectory, source)), fs.readFile(path.join(directory, output))]);
        const tables = readTables(bytes, true);
        checkTables(readTables(original, true), tables, style === undefined);
        checkPaint(hb, bytes, tables, style, colors);
        if (style === undefined) checkSvg(hb, bytes, tables, colors);
        console.log(`Verified ${output}`);
      } catch (error) {
        throw new Error(`${output}: ${error.message}`, { cause: error });
      }
    }
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
