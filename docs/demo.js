const text = document.querySelector('#sample-text');
const specimen = document.querySelector('#specimen');
const title = document.querySelector('#title');
const weight = document.querySelector('#weight');
const size = document.querySelector('#size');
const weightValue = document.querySelector('#weight-value');
const sizeValue = document.querySelector('#size-value');
const status = document.querySelector('#font-status');
const sampleButtons = document.querySelectorAll('[data-sample]');

const samples = {
  mixed: text.defaultValue,
  japanese: '人類社会のすべての構成員の固有の尊厳と平等で譲ることのできない権利とを承認することは',
  latin: 'Nottsu Sans JP\nThe quick brown fox jumps over the lazy dog.\n0123456789',
};

// Browsers without COLR v1 support (such as Safari) get the same colors
// from a JavaScript renderer instead; it is loaded on demand below.
let renderer;

function updatePreview() {
  weightValue.value = weight.value;
  sizeValue.value = `${size.value}px`;
  for (const button of sampleButtons) {
    button.setAttribute('aria-pressed', String(samples[button.dataset.sample] === text.value));
  }
  if (renderer) {
    specimen.setAttribute('aria-label', text.value);
    specimen.innerHTML = renderer.render(text.value, {
      weight: Number(weight.value),
      size: Number(size.value),
      maxWidth: specimen.clientWidth,
    });
  } else {
    specimen.textContent = text.value;
    specimen.style.setProperty('--sample-weight', weight.value);
    specimen.style.setProperty('--sample-size', `${size.value}px`);
  }
}

function renderTitle() {
  if (!renderer) return;
  title.setAttribute('aria-label', title.textContent);
  title.innerHTML = renderer.render(title.textContent, { weight: 700, size: 92 });
}

for (const control of [text, weight, size]) control.addEventListener('input', updatePreview);

for (const button of sampleButtons) {
  button.addEventListener('click', () => {
    text.value = samples[button.dataset.sample];
    updatePreview();
  });
}

document.querySelector('#reset').addEventListener('click', () => {
  text.value = samples.mixed;
  weight.value = weight.defaultValue;
  size.value = size.defaultValue;
  updatePreview();
});

window.addEventListener('resize', () => {
  if (renderer) updatePreview();
});

updatePreview();

if (CSS.supports('font-tech(color-COLRv1)')) {
  document.fonts.load('400 24px "Nottsu Sans JP"').then((fonts) => {
    if (fonts.length === 0) throw new Error('The font is unavailable.');
    status.hidden = true;
  }).catch(() => {
    status.textContent = 'The font could not be loaded. Reload to try again.';
  });
} else {
  Promise.all([import('./assets/hb/index.mjs'), import('./assets/render.js')])
    .then(([harfbuzz, { createColorRenderer }]) => createColorRenderer(harfbuzz, './assets/NottsuSansJP-VariableFont_wght.ttf'))
    .then((loaded) => {
      renderer = loaded;
      status.hidden = true;
      updatePreview();
      renderTitle();
    })
    .catch(() => {
      status.textContent = 'Color rendering requires a browser with COLR v1 support.';
    });
}
