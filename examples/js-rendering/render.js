// Renders Nottsu Sans JP in color in any modern browser, including ones
// without COLR v1 support such as Safari.
//
// The font's color design is a sweep gradient whose four flat colors meet
// at each glyph's center. This module reads that paint data out of the
// font with HarfBuzz and redraws every glyph as inline SVG: the glyph
// outline clips one sector per color span of the sweep. The result matches
// the COLR v1 rendering, and because HarfBuzz applies font variations
// before painting, the weight axis keeps working.
//
// Usage:
//   import * as harfbuzz from '.../harfbuzzjs/dist/index.mjs';
//   const renderer = await createColorRenderer(harfbuzz, fontUrl);
//   element.innerHTML = renderer.render('色であそぶ、ことば。', { weight: 400, size: 68, maxWidth: 600 });

// Clip path ids must be unique across the whole document: several
// rendered SVGs on one page share the id namespace, and a collision makes
// a glyph show the outline of whichever glyph claimed the id first.
let nextClipId = 0;

// Keeps path data compact: variation outlines come back with long float
// tails, and a tenth of a font unit is far below visible precision.
function roundCoordinate(text) {
  return text.replace(/\d+\.\d{2,}/g, (match) => String(Math.round(Number(match) * 10) / 10));
}

// One sweep sector as an SVG path, in glyph coordinates (y-axis up).
function sectorPath(cx, cy, radius, start, end, { red, green, blue, alpha }) {
  const point = (angle) => `${(cx + radius * Math.cos(angle)).toFixed(1)} ${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  const largeArc = Number(end - start > Math.PI);
  const opacity = alpha !== 255 ? ` fill-opacity="${alpha / 255}"` : '';
  return `<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${point(start)} A ${radius} ${radius} 0 ${largeArc} 1 ${point(end)} Z" fill="rgb(${red},${green},${blue})"${opacity}/>`;
}

export async function createColorRenderer(harfbuzz, fontUrl) {
  const response = await fetch(fontUrl);
  if (!response.ok) throw new Error(`Could not load the font: ${response.status}`);
  const face = new harfbuzz.Face(new harfbuzz.Blob(await response.arrayBuffer()));
  const font = new harfbuzz.Font(face);
  const unitsPerEm = face.upem;

  // The paint callbacks capture the sweep gradient of one glyph, with the
  // accumulated translations applied to its center.
  const paint = new harfbuzz.PaintFuncs();
  const translations = [];
  let sweep;
  paint.setPushTransformFunc((_xx, _yx, _xy, _yy, dx, dy) => translations.push([dx, dy]));
  paint.setPopTransformFunc(() => translations.pop());
  paint.setSweepGradientFunc((line, x, y, start, end) => {
    const [cx, cy] = translations.reduce(([sx, sy], [dx, dy]) => [sx + dx, sy + dy], [x, y]);
    sweep = { stops: line.colorStops, x: cx, y: cy, start, end };
  });

  function glyphArtwork(id, originX, baseline, scale, clipId) {
    const outline = roundCoordinate(font.glyphToPath(id) ?? '');
    if (!outline) return '';
    sweep = undefined;
    translations.length = 0;
    let sectors = '';
    if (font.paintGlyphOrFail(id, paint) && sweep) {
      const angleAt = (offset) => sweep.start + offset * (sweep.end - sweep.start);
      sectors = sweep.stops.slice(0, -1).flatMap(({ offset, color }, index) => {
        const next = sweep.stops[index + 1].offset;
        return offset < next
          ? [sectorPath(sweep.x, sweep.y, 4 * unitsPerEm, angleAt(offset), angleAt(next), color)]
          : [];
      }).join('');
    }
    // HarfBuzz outlines use y-up coordinates, while SVG uses y-down.
    const transform = `translate(${originX} ${baseline}) scale(${scale} ${-scale})`;
    if (!sectors) return `<g transform="${transform}"><path d="${outline}"/></g>`;
    return `<g transform="${transform}"><clipPath id="${clipId}"><path d="${outline}"/></clipPath><g clip-path="url(#${clipId})">${sectors}</g></g>`;
  }

  function shapeLine(text) {
    const run = new harfbuzz.Buffer();
    run.addText(text);
    run.guessSegmentProperties();
    run.setLanguage('ja');
    harfbuzz.shape(font, run);
    return { glyphs: run.getGlyphInfos(), positions: run.getGlyphPositions() };
  }

  // Splits one paragraph into lines that fit maxWidth (in px). Lines break
  // between characters, like CSS `overflow-wrap: anywhere`, except that
  // 、 and 。 stay attached to the character before them so they never
  // start a line (the same rule scripts/sample.js uses for its images).
  function wrapParagraph(text, scale, maxWidth) {
    if (!text) return [{ glyphs: [], positions: [], advance: 0 }];
    const units = [...text.matchAll(/.[、。]*/gu)].map((match) => {
      const { glyphs, positions } = shapeLine(match[0]);
      return { glyphs, positions, advance: positions.reduce((sum, position) => sum + position.xAdvance, 0) };
    });
    const lines = [];
    let line = { glyphs: [], positions: [], advance: 0 };
    for (const unit of units) {
      if (line.glyphs.length && (line.advance + unit.advance) * scale > maxWidth) {
        lines.push(line);
        line = { glyphs: [], positions: [], advance: 0 };
      }
      line.glyphs.push(...unit.glyphs);
      line.positions.push(...unit.positions);
      line.advance += unit.advance;
    }
    lines.push(line);
    return lines;
  }

  return {
    unitsPerEm,
    // Returns an SVG string. `size` is the font size in px, `weight` a
    // number from 100 to 900, and `maxWidth` the line width in px.
    render(text, { weight = 400, size = 68, maxWidth = Infinity } = {}) {
      font.setVariations([harfbuzz.Variation.fromString(`wght=${weight}`)]);
      const scale = size / unitsPerEm;
      const lineHeight = size * 1.35;
      const lines = text.split('\n').flatMap((paragraph) => wrapParagraph(paragraph, scale, maxWidth));
      let width = 0;
      const artwork = lines.map((line, row) => {
        width = Math.max(width, line.advance * scale);
        const baseline = row * lineHeight + (lineHeight - size) / 2 + size * 0.85;
        let x = 0;
        return line.glyphs.map((glyph, index) => {
          const { xOffset, yOffset, xAdvance } = line.positions[index];
          const artwork = glyphArtwork(glyph.codepoint, (x + xOffset) * scale, baseline - yOffset * scale, scale, `nottsu-glyph-${nextClipId++}`);
          x += xAdvance;
          return artwork;
        }).join('');
      }).join('');
      const height = Math.max(1, lines.length) * lineHeight;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, width).toFixed(1)} ${height.toFixed(1)}" width="${Math.max(1, width).toFixed(1)}" height="${height.toFixed(1)}" role="img">${artwork}</svg>`;
    },
  };
}
