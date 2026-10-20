'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Post Template settings UI
// ═══════════════════════════════════════════════════════════════════════════════
function buildTemplateUI() {
  const templateArea  = document.getElementById('cfg-postTemplate');
  const chipsEl       = document.getElementById('stg-varChips');
  const titleInput    = document.getElementById('cfg-titleTemplate');
  const titleChipsEl  = document.getElementById('stg-titleVarChips');

  // Helper: build a chip strip for a given input/textarea target
  function buildChips(container, targetEl) {
    container.innerHTML = '';
    TEMPLATE_VARS.forEach(token => {
      const chip = document.createElement('button');
      chip.className = 'var-chip';
      chip.type = 'button';
      chip.textContent = token;
      chip.title = 'Click to insert at cursor, or double-click to copy';

      chip.addEventListener('click', () => {
        const start = targetEl.selectionStart;
        const end   = targetEl.selectionEnd;
        const before = targetEl.value.slice(0, start);
        const after  = targetEl.value.slice(end);
        targetEl.value = before + token + after;
        targetEl.selectionStart = targetEl.selectionEnd = start + token.length;
        targetEl.focus();
      });

      chip.addEventListener('dblclick', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(token).catch(() => {});
        chip.classList.add('copied');
        setTimeout(() => chip.classList.remove('copied'), 1200);
      });

      container.appendChild(chip);
    });
  }

  const linkRowInput  = document.getElementById('cfg-linkRowTemplate');
  const linkRowChipsEl = document.getElementById('stg-linkRowVarChips');

  buildChips(chipsEl,       templateArea);
  buildChips(titleChipsEl,  titleInput);

  // Part row template — uses its own dedicated token set
  if (linkRowInput && linkRowChipsEl) {
    linkRowChipsEl.innerHTML = '';
    LINK_ROW_VARS.forEach(token => {
      const chip = document.createElement('button');
      chip.className = 'var-chip';
      chip.type = 'button';
      chip.textContent = token;
      chip.title = 'Click to insert at cursor, or double-click to copy';
      chip.addEventListener('click', () => {
        const start = linkRowInput.selectionStart;
        const end   = linkRowInput.selectionEnd;
        linkRowInput.value = linkRowInput.value.slice(0, start) + token + linkRowInput.value.slice(end);
        linkRowInput.selectionStart = linkRowInput.selectionEnd = start + token.length;
        linkRowInput.focus();
      });
      chip.addEventListener('dblclick', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(token).catch(() => {});
        chip.classList.add('copied');
        setTimeout(() => chip.classList.remove('copied'), 1200);
      });
      linkRowChipsEl.appendChild(chip);
    });
  }

  // Reset buttons
  document.getElementById('cfg-resetTemplate').addEventListener('click', () => {
    templateArea.value = DEFAULT_POST_TEMPLATE;
  });
  document.getElementById('cfg-resetTitleTemplate').addEventListener('click', () => {
    titleInput.value = DEFAULT_TITLE_TEMPLATE;
  });
  document.getElementById('cfg-resetLinkRowTemplate')?.addEventListener('click', () => {
    if (linkRowInput) linkRowInput.value = DEFAULT_LINK_ROW_TEMPLATE;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Theme engine
// ═══════════════════════════════════════════════════════════════════════════════

// All CSS custom properties the user can edit, in display order
const THEME_VARS = [
  // group, key in theme object, CSS var name, display label
  { group:'Backgrounds',   key:'bg',          css:'--bg',       label:'Deep background'    },
  { group:'Backgrounds',   key:'bg2',         css:'--bg2',      label:'Sidebar & header'   },
  { group:'Backgrounds',   key:'surface',     css:'--surface',  label:'Panels & inputs'    },
  { group:'Text',          key:'hi',          css:'--hi',       label:'Headings & values'  },
  { group:'Text',          key:'text',        css:'--text',     label:'Body text'           },
  { group:'Text',          key:'text2',       css:'--text2',    label:'Labels'              },
  { group:'Text',          key:'text3',       css:'--text3',    label:'Dim / placeholders' },
  { group:'Interactive',   key:'accent',      css:'--accent',   label:'Accent colour'      },
  { group:'Interactive',   key:'acc2',        css:'--acc2',     label:'Focus ring'         },
  { group:'Interactive',   key:'accent2',     css:'--accent2',  label:'Confirm button'     },
  { group:'Interactive',   key:'border',      css:'--border',   label:'Borders'            },
  { group:'Log output',    key:'logError',    css:'--red',      label:'Errors'             },
  { group:'Log output',    key:'logNotice',   css:'--yellow',   label:'Notices'            },
  { group:'Log output',    key:'logDone',     css:'--green',    label:'Done / success'     },
  { group:'Log output',    key:'logDownload', css:'--teal',     label:'Downloading'        },
  { group:'Log output',    key:'logDecrypt',  css:'--rose',     label:'Decrypting'         },
];

// Built-in preset themes
const PRESETS = [
  {
    name: 'Frosted Steel',
    dots: ['#f0f3f7','#2060b8','#1a2d42'],
    theme: {
      bg:'#f0f3f7', bg2:'#e2e8f0', surface:'#fafbfd',
      hi:'#0e1e30', text:'#1a2d42', text2:'#3a5270', text3:'#6880a0',
      accent:'#2060b8', acc2:'#0e3d80', accent2:'#1a7060', border:'#bccde0',
      logError:'#b02020', logNotice:'#7a5400', logDone:'#1a7030',
      logDownload:'#1a5878', logDecrypt:'#782868',
      sansFont:"'Recursive',-apple-system,sans-serif",
      monoFont:"'Recursive Monospace',monospace",
      fontSize: 13,
    },
  },
  {
    name: 'Lavender Mist',
    dots: ['#ece8f5','#6048a8','#1e1530'],
    theme: {
      bg:'#ece8f5', bg2:'#ddd8ee', surface:'#f5f2fc',
      hi:'#1a1230', text:'#2a2045', text2:'#4a3878', text3:'#7a68a8',
      accent:'#6048a8', acc2:'#3d2e80', accent2:'#c06820', border:'#c4b8e0',
      logError:'#b02040', logNotice:'#7a5800', logDone:'#226622',
      logDownload:'#1a6878', logDecrypt:'#882868',
      sansFont:"'Montserrat',-apple-system,'Segoe UI',sans-serif",
      monoFont:"'Google Sans Code','Cascadia Code',monospace",
      fontSize: 13,
    },
  },
  {
    name: 'Tea Rose',
    dots: ['#fdf0f3','#b02856','#3c1a28'],
    theme: {
      bg:'#fdf0f3', bg2:'#f5e4e9', surface:'#fff7f9',
      hi:'#280e1a', text:'#3c1a28', text2:'#7a3858', text3:'#b07890',
      accent:'#b02856', acc2:'#780a38', accent2:'#b06010', border:'#e8c4d0',
      logError:'#8a0820', logNotice:'#7a5000', logDone:'#226624',
      logDownload:'#1a6070', logDecrypt:'#7a2870',
      sansFont:"'Epilogue',-apple-system,'Segoe UI',sans-serif",
      monoFont:"'Geist Mono','Cascadia Code',monospace",
      fontSize: 13,
    },
  },
  {
    name: 'Saffron',
    dots: ['#fdf8f0','#a86818','#2e2010'],
    theme: {
      bg:'#fdf8f0', bg2:'#f5edd8', surface:'#fffcf7',
      hi:'#1c1008', text:'#2e2010', text2:'#665030', text3:'#a88060',
      accent:'#a86818', acc2:'#704010', accent2:'#2a6040', border:'#e0ca98',
      logError:'#a82020', logNotice:'#7a5200', logDone:'#226820',
      logDownload:'#1a6070', logDecrypt:'#782060',
      sansFont:"'Source Serif 4',-apple-system,'Segoe UI',sans-serif",
      monoFont:"'Source Code Pro','Cascadia Code',monospace",
      fontSize: 13,
    },
  },
  {
    name: 'Neon Carnival',
    dots: ['#0d0a1a','#8338ec','#ffbe0b'],
    theme: {
      bg:'#0d0a1a', bg2:'#130f22', surface:'#1a1530',
      hi:'#f5f0ff', text:'#ddd4f8', text2:'#9078d0', text3:'#5a4880',
      accent:'#8338ec', acc2:'#5a20c4', accent2:'#ffbe0b', border:'#2a1f50',
      logError:'#ff006e', logNotice:'#ffbe0b', logDone:'#00e090',
      logDownload:'#3a86ff', logDecrypt:'#fb5607',
      sansFont:"'Share',-apple-system,'Segoe UI',sans-serif",
      monoFont:"'Share Tech Mono','Cascadia Code',monospace",
      fontSize: 14,
    },
  },
  {
    name: 'Pastel Reverie',
    dots: ['#fffffc','#bdb2ff','#ffadad'],
    theme: {
      bg:'#fffffc', bg2:'#f0eeff', surface:'#fffffc',
      hi:'#2a1e5c', text:'#362870', text2:'#6858b0', text3:'#9e90cc',
      accent:'#7060cc', acc2:'#4c3aaa', accent2:'#c45878', border:'#bdb2ff',
      logError:'#b83060', logNotice:'#906010', logDone:'#2a7a48',
      logDownload:'#2858b8', logDecrypt:'#8a3898',
      sansFont:"'Recursive',-apple-system,'Segoe UI',sans-serif",
      monoFont:"'Recursive Mono','Cascadia Code',monospace",
      fontSize: 13,
    },
  },
  {
    name: 'Phosphor',
    dots: ['#050f05','#00ff41','#00cc33'],
    theme: {
      bg:'#050f05', bg2:'#091409', surface:'#0d190d',
      hi:'#00ff41', text:'#00cc33', text2:'#009926', text3:'#005c17',
      accent:'#00ff41', acc2:'#00b32d', accent2:'#ccaa00', border:'#0a3d0a',
      logError:'#ff3333', logNotice:'#ccaa00', logDone:'#00ff41',
      logDownload:'#00ccaa', logDecrypt:'#88ff44',
      sansFont:"'Share Tech','Cascadia Code',monospace",
      monoFont:"'IBM Plex Mono','Cascadia Code',monospace",
      fontSize: 14,
    },
  },
  {
    name: 'Midnight Ember',
    dots: ['#0c0804', '#e05000', '#ffd88a'],
    theme: {
      bg:'#0c0804', bg2:'#140e06', surface:'#1c140a',
      hi:'#ffd88a', text:'#e0b870', text2:'#a07840', text3:'#6a4e2a',
      accent:'#e05000', acc2:'#a02800', accent2:'#c09800', border:'#2c1a08',
      logError:'#ff5040', logNotice:'#d4a000', logDone:'#30c050',
      logDownload:'#18a0b8', logDecrypt:'#d040a0',
      sansFont:"'Inter',-apple-system,sans-serif",
      monoFont:"'Source Code Pro',monospace",
      fontSize: 14,
    },
  },
{
  name: 'Neon Sherbet',
  dots: ['#0e0b18', '#d4aaff', '#ffe4f7'],
  theme: {
    bg:      '#0e0b18',
    bg2:     '#16122a',
    surface: '#1e1a38',

    hi:    '#ffe4f7',
    text:  '#d4b8f0',
    text2: '#9070c0',
    text3: '#503878',

    accent:  '#d4aaff',
    acc2:    '#9060d8',
    accent2: '#aaf5d8',
    border:  '#2e2858',

    logError:    '#ff9db8',
    logNotice:   '#ffd4a0',
    logDone:     '#a8f0c0',
    logDownload: '#80e8ff',
    logDecrypt:  '#f0b0ff',

    sansFont: "'Outfit',-apple-system,sans-serif",
    monoFont: "'Geist Mono',monospace",
    fontSize: 13,
  },
},

{
  name: 'Sugar Plum',
  dots: ['#f2ebf7', '#b555d8', '#fefbff'],
  theme: {
    bg:      '#f2ebf7',
    bg2:     '#f8f1fc',
    surface: '#fefbff',

    hi:    '#2b1840',
    text:  '#46306a',
    text2: '#8b6aaa',
    text3: '#c4abda',

    accent:  '#b555d8',
    acc2:    '#8a3ab0',
    accent2: '#e0608a',
    border:  '#e5d5f5',

    logError:    '#c42e50',
    logNotice:   '#b06000',
    logDone:     '#18845a',
    logDownload: '#0b7a9a',
    logDecrypt:  '#9030b8',

    sansFont: "'Nunito',-apple-system,sans-serif",
    monoFont: "'Maple Mono',monospace",
    fontSize: 13,
  },
},


];

// The live working theme — starts as a copy of the active preset
let activeTheme = { ...PRESETS[0].theme };
let activePresetName = PRESETS[0].name;

// Inject (or update) a <style> tag that overrides :root vars
const themeStyleEl = document.createElement('style');
themeStyleEl.id = 'theme-override';
document.head.appendChild(themeStyleEl);

function applyTheme(theme) {
  const vars = THEME_VARS.map(v => `  ${v.css}: ${theme[v.key]};`).join('\n');
  const fontVars = `
  --sans: ${theme.sansCustom ? `"${theme.sansCustom}",${theme.sansFont}` : theme.sansFont};
  --mono: ${theme.monoCustom ? `"${theme.monoCustom}",${theme.monoFont}` : theme.monoFont};`;

  themeStyleEl.textContent = `:root {\n${vars}\n${fontVars}\n}`;

  // Font size — scale the .app container.
  // All font sizes in the CSS are hardcoded in px, so neither html.fontSize nor
  // zoom work without clipping. Instead we shrink the .app's layout dimensions
  // by the inverse of the scale factor, then scale it back up visually with
  // transform. The element occupies less layout space than the viewport, so
  // nothing overflows, and the transform fills it back to exactly 100vw×100vh.
  const scale = (theme.fontSize || 13) / 13;
  const appEl = document.querySelector('.app');
  if (appEl) {
    if (scale === 1) {
      appEl.style.transform = '';
      appEl.style.transformOrigin = '';
      appEl.style.width = '';
      appEl.style.height = '';
    } else {
      appEl.style.transformOrigin = 'top left';
      appEl.style.transform = `scale(${scale})`;
      appEl.style.width  = `${100 / scale}vw`;
      appEl.style.height = `${100 / scale}vh`;
    }
  }
}

// Export the current theme as a JSON file download
function exportTheme() {
  const slug = (activePresetName || 'custom').replace(/\s+/g, '-').toLowerCase();
  const blob = new Blob([JSON.stringify(activeTheme, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `m3-theme-${slug}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Import a theme from a JSON file and apply it immediately
function importTheme(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      // Merge over the base preset so any missing keys stay valid
      activeTheme = { ...PRESETS[0].theme, ...parsed };
      activePresetName = '';
      applyTheme(activeTheme);
      populateThemePickers(activeTheme);
      populateFontControls(activeTheme);
      buildPresetButtons();
      showToast('Theme imported.', 3000);
    } catch {
      showToast('⚠ Could not read theme file — make sure it is a valid M3 theme JSON.', 5000);
    }
  };
  reader.readAsText(file);
}

// Build the color picker groups in the settings panel
function buildColorPickers() {
  const container = document.getElementById('colorGroups');
  container.innerHTML = '';

  // Group vars by their group label
  const groups = {};
  THEME_VARS.forEach(v => {
    if (!groups[v.group]) groups[v.group] = [];
    groups[v.group].push(v);
  });

  Object.entries(groups).forEach(([groupName, vars]) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'color-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'color-group-label';
    labelEl.textContent = groupName;
    groupEl.appendChild(labelEl);

    const grid = document.createElement('div');
    grid.className = 'color-grid';

    vars.forEach(v => {
      const color = activeTheme[v.key] || '#000000';

      const wrap = document.createElement('label');
      wrap.className = 'swatch-wrap';
      wrap.title = `Click to change ${v.label}`;

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'swatch-input';
      input.dataset.key = v.key;
      input.dataset.css = v.css;
      input.value = color;

      const swatch = document.createElement('span');
      swatch.className = 'swatch-color';
      swatch.style.background = color;

      const info = document.createElement('span');
      info.className = 'swatch-info';

      const lbl = document.createElement('span');
      lbl.className = 'swatch-label';
      lbl.textContent = v.label;

      const hex = document.createElement('span');
      hex.className = 'swatch-hex';
      hex.textContent = color;

      // Live preview as user drags the colour picker
      input.addEventListener('input', e => {
        const val = e.target.value;
        swatch.style.background = val;
        hex.textContent = val;
        activeTheme[v.key] = val;
        applyTheme(activeTheme);
        // Deselect any preset since user customised
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        activePresetName = '';
      });

      info.appendChild(lbl);
      info.appendChild(hex);
      wrap.appendChild(input);
      wrap.appendChild(swatch);
      wrap.appendChild(info);
      grid.appendChild(wrap);
    });

    groupEl.appendChild(grid);
    container.appendChild(groupEl);
  });
}

// Update all picker values + swatches from a theme object (without triggering events)
function populateThemePickers(theme) {
  document.querySelectorAll('.swatch-input').forEach(input => {
    const key = input.dataset.key;
    const val = theme[key] || '#000000';
    input.value = val;
    const wrap = input.closest('.swatch-wrap');
    if (wrap) {
      wrap.querySelector('.swatch-color').style.background = val;
      wrap.querySelector('.swatch-hex').textContent = val;
    }
  });
}

// Build preset buttons
function buildPresetButtons() {
  const container = document.getElementById('themePresets');
  container.innerHTML = '';
  PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn' + (preset.name === activePresetName ? ' active' : '');
    btn.dataset.name = preset.name;

    const dots = document.createElement('span');
    dots.className = 'preset-dots';
    preset.dots.forEach(color => {
      const d = document.createElement('span');
      d.className = 'preset-dot';
      d.style.background = color;
      d.style.border = '1px solid rgba(255,255,255,0.15)';
      dots.appendChild(d);
    });

    btn.appendChild(dots);
    btn.appendChild(document.createTextNode(preset.name));

    btn.addEventListener('click', () => {
      activeTheme = { ...preset.theme };
      activePresetName = preset.name;
      applyTheme(activeTheme);
      populateThemePickers(activeTheme);
      populateFontControls(activeTheme);
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    container.appendChild(btn);
  });
}

// Font controls
function populateFontControls(theme) {
  const sansEl  = document.getElementById('cfg-sansFont');
  const monoEl  = document.getElementById('cfg-monoFont');
  const sizeEl  = document.getElementById('cfg-fontSize');
  const sizeVal = document.getElementById('cfg-fontSizeVal');

  // Match option value exactly; if nothing matches, show the placeholder so
  // the dropdown doesn't silently display a stale/wrong selection.
  function syncFontSelect(selectEl, fontValue) {
    let matched = false;
    [...selectEl.options].forEach(o => {
      if (o.classList.contains('preset-placeholder')) { o.selected = false; return; }
      o.selected = (o.value === fontValue);
      if (o.value === fontValue) matched = true;
    });
    if (!matched) {
      const ph = selectEl.querySelector('.preset-placeholder');
      if (ph) ph.selected = true;
    }
  }

  syncFontSelect(sansEl, theme.sansFont);
  syncFontSelect(monoEl, theme.monoFont);

  const sansCustomEl = document.getElementById('cfg-sansCustom');
  const monoCustomEl = document.getElementById('cfg-monoCustom');
  sansCustomEl.value = theme.sansCustom || '';
  monoCustomEl.value = theme.monoCustom || '';

  // #3 Live-preview: render each custom field in its own declared font
  sansCustomEl.style.fontFamily = theme.sansCustom || '';
  monoCustomEl.style.fontFamily = theme.monoCustom || '';

  // #4 Disable the dropdown while a custom override is active so the two
  // controls can't give conflicting signals about what font is in use
  const overrideTitle = 'Overridden by custom font above — clear that field to re-enable';
  sansEl.disabled = !!(theme.sansCustom);
  sansEl.title    = theme.sansCustom ? overrideTitle : '';
  monoEl.disabled = !!(theme.monoCustom);
  monoEl.title    = theme.monoCustom ? overrideTitle : '';

  // Clear stale verification badges when repopulating from a preset
  const sansStatus = document.getElementById('cfg-sansCustomStatus');
  const monoStatus = document.getElementById('cfg-monoCustomStatus');
  if (sansStatus) { sansStatus.textContent = theme.sansCustom ? sansStatus.textContent : ''; }
  if (monoStatus) { monoStatus.textContent = theme.monoCustom ? monoStatus.textContent : ''; }
  sizeEl.value = theme.fontSize || 13;
  sizeVal.textContent = (theme.fontSize || 13) + 'px';
}

// Wire font controls → live preview
document.getElementById('cfg-sansFont').addEventListener('change', e => {
  activeTheme.sansFont = e.target.value;
  applyTheme(activeTheme);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  activePresetName = '';
});
document.getElementById('cfg-monoFont').addEventListener('change', e => {
  activeTheme.monoFont = e.target.value;
  applyTheme(activeTheme);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  activePresetName = '';
});
// Canvas-based system font availability check (works in Electron/Chromium).
// Renders a test string against serif and monospace generic families; if the
// measured width changes when prepending the target font, it loaded.
function isFontAvailable(fontName) {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmmlli';
    const sz = '72px ';
    ctx.font = sz + 'serif';      const sw = ctx.measureText(probe).width;
    ctx.font = sz + 'monospace';  const mw = ctx.measureText(probe).width;
    ctx.font = `${sz}"${fontName}", serif`;      const tw1 = ctx.measureText(probe).width;
    ctx.font = `${sz}"${fontName}", monospace`;  const tw2 = ctx.measureText(probe).width;
    return tw1 !== sw || tw2 !== mw;
  } catch { return false; }
}

function setFontStatus(statusEl, fontName) {
  if (!statusEl) return;
  if (!fontName) { statusEl.textContent = ''; return; }
  const found = isFontAvailable(fontName);
  statusEl.textContent = found ? '✓ matched' : '✗ not found';
  statusEl.style.color  = found ? 'var(--green)' : 'var(--red)';
  statusEl.title = found
    ? `"${fontName}" is available on this system`
    : `"${fontName}" was not detected — check the spelling or try the full font family name`;
}

let _sansFontVerifyTimer = null;
let _monoFontVerifyTimer = null;

document.getElementById('cfg-sansCustom').addEventListener('input', e => {
  const val = e.target.value.trim();
  activeTheme.sansCustom = val;
  applyTheme(activeTheme);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  activePresetName = '';
  // #3 Live-preview: show the typed font inside the input itself
  e.target.style.fontFamily = val || '';
  // #4 Disable the dropdown while a custom value is present
  const sansDropdown = document.getElementById('cfg-sansFont');
  const overrideTitle = 'Overridden by custom font above — clear that field to re-enable';
  sansDropdown.disabled = !!val;
  sansDropdown.title    = val ? overrideTitle : '';
  const statusEl = document.getElementById('cfg-sansCustomStatus');
  if (statusEl) { statusEl.textContent = val ? '…' : ''; statusEl.style.color = 'var(--text3)'; }
  clearTimeout(_sansFontVerifyTimer);
  _sansFontVerifyTimer = setTimeout(() => setFontStatus(statusEl, val), 600);
});
document.getElementById('cfg-monoCustom').addEventListener('input', e => {
  const val = e.target.value.trim();
  activeTheme.monoCustom = val;
  applyTheme(activeTheme);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  activePresetName = '';
  // #3 Live-preview: show the typed font inside the input itself
  e.target.style.fontFamily = val || '';
  // #4 Disable the dropdown while a custom value is present
  const monoDropdown = document.getElementById('cfg-monoFont');
  const overrideTitle = 'Overridden by custom font above — clear that field to re-enable';
  monoDropdown.disabled = !!val;
  monoDropdown.title    = val ? overrideTitle : '';
  const statusEl = document.getElementById('cfg-monoCustomStatus');
  if (statusEl) { statusEl.textContent = val ? '…' : ''; statusEl.style.color = 'var(--text3)'; }
  clearTimeout(_monoFontVerifyTimer);
  _monoFontVerifyTimer = setTimeout(() => setFontStatus(statusEl, val), 600);
});
const fontSizeEl  = document.getElementById('cfg-fontSize');
const fontSizeVal = document.getElementById('cfg-fontSizeVal');
fontSizeEl.addEventListener('input', e => {
  const sz = parseInt(e.target.value, 10);
  fontSizeVal.textContent = sz + 'px';
  activeTheme.fontSize = sz;
  applyTheme(activeTheme);
});

// Reset to current preset (or Hearthside if none)
document.getElementById('cfg-resetTheme').addEventListener('click', () => {
  const preset = PRESETS.find(p => p.name === activePresetName) || PRESETS[0];
  activeTheme = { ...preset.theme };
  activePresetName = preset.name;
  applyTheme(activeTheme);
  populateThemePickers(activeTheme);
  populateFontControls(activeTheme);
  buildPresetButtons();
});

document.getElementById('cfg-exportTheme').addEventListener('click', exportTheme);

const _importThemeFileInput = document.getElementById('cfg-importThemeFile');
document.getElementById('cfg-importTheme').addEventListener('click', () => {
  _importThemeFileInput.value = ''; // reset so the same file can be re-imported
  _importThemeFileInput.click();
});
_importThemeFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) importTheme(file);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Settings — proxy, default dir, save
// ═══════════════════════════════════════════════════════════════════════════════
const cfgProxy      = document.getElementById('cfg-proxy');
const cfgDataDir    = document.getElementById('cfg-dataDir');
const cfgDefaultDir = document.getElementById('cfg-defaultDir');
const cfgBrowseDir  = document.getElementById('cfg-browseDir');
const cfgClearDir   = document.getElementById('cfg-clearDir');
const cfgTempDir    = document.getElementById('cfg-tempDir');
const cfgBrowseTempDir = document.getElementById('cfg-browseTempDir');
const cfgClearTempDir  = document.getElementById('cfg-clearTempDir');
const cfgSplitSizeGb        = document.getElementById('cfg-splitSizeGb');
const cfgSplitThresholdGb   = document.getElementById('cfg-splitThresholdGb');
const cfgAccountThresholdGb = document.getElementById('cfg-accountThresholdGb');
const cfgSave       = document.getElementById('cfg-save');
const cfgSaveTop    = document.getElementById('cfg-save-top');

// ── Tab locking ───────────────────────────────────────────────────────────────
// When no data folder is configured the Download and Upload tabs are disabled
// and the app opens directly on Settings.  Once the user saves a folder the
// lock is released without needing a restart.
function setTabsLocked(lockedData, lockedProxy) {
  const locked = lockedData || lockedProxy;
  document.querySelectorAll('.tab[data-tab="download"], .tab[data-tab="upload"]').forEach(btn => {
    btn.disabled = locked;
    btn.style.opacity = locked ? '0.4' : '';
    btn.style.cursor  = locked ? 'not-allowed' : '';
    btn.title = locked ? 'Complete required Settings first' : '';
  });

  const reqBadgeData = document.getElementById('stg-dataFolderRequired');
  const cardData     = document.getElementById('stg-dataFolderCard');
  if (reqBadgeData) reqBadgeData.style.display = lockedData ? '' : 'none';
  if (cardData) cardData.style.outline = lockedData ? '2px solid var(--accent)' : '';

  const reqBadgeProxy = document.getElementById('stg-proxyRequired');
  const cardProxy     = document.getElementById('stg-proxyCard');
  if (reqBadgeProxy) reqBadgeProxy.style.display = lockedProxy ? '' : 'none';
  if (cardProxy) cardProxy.style.outline = lockedProxy ? '2px solid var(--accent)' : '';
}

function openSettingsTab() {
  document.getElementById('mailPanel').hidden = true;
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
  const stab = document.querySelector('.tab[data-tab="settings"]');
  if (stab) stab.classList.add('active');
  dlSidebar.style.display = 'none';
  upSidebar.style.display = 'none';
  downloadPanel.classList.add('hidden');
  uploadPanel.classList.add('hidden');
  settingsPanel.classList.add('active');
}

const cfgDlThreads          = document.getElementById('cfg-dlThreads');
const cfgDlThreadsVal       = document.getElementById('cfg-dlThreadsVal');
const cfgStreamingChunkSize = document.getElementById('cfg-streamingChunkSize');
const cfgStreamMethod       = document.getElementById('cfg-streamMethod');
cfgDlThreads.addEventListener('input', () => {
  cfgDlThreadsVal.textContent = cfgDlThreads.value;
});

// ── megatools upload workers slider — live update ─────────────────────────────
const cfgUploadWorkers    = document.getElementById('cfg-uploadWorkers');
const cfgUploadWorkersVal = document.getElementById('cfg-uploadWorkersVal');
cfgUploadWorkers.addEventListener('input', () => {
  cfgUploadWorkersVal.textContent = cfgUploadWorkers.value;
});

const cfgMegacmdConnections    = document.getElementById('cfg-megacmdConnections');
const cfgMegacmdConnectionsVal = document.getElementById('cfg-megacmdConnectionsVal');
cfgMegacmdConnections.addEventListener('input', () => {
  cfgMegacmdConnectionsVal.textContent = cfgMegacmdConnections.value;
});

// ── Sidebar width — live update ───────────────────────────────────────────────
const cfgSidebarWidth    = document.getElementById('cfg-sidebarWidth');
const cfgSidebarWidthNum = document.getElementById('cfg-sidebarWidthNum');
const cfgLinksPerPage      = document.getElementById('cfg-linksPerPage');
const cfgAccountsPerPage   = document.getElementById('cfg-accountsPerPage');
const cfgDownloadsPerPage  = document.getElementById('cfg-downloadsPerPage');
const cfgMediaInfoPerPage  = document.getElementById('cfg-mediaInfoPerPage');
const cfgImportsPerPage    = document.getElementById('cfg-importsPerPage');
const cfgMicHistoryPerPage = document.getElementById('cfg-micHistoryPerPage');

function applySidebarWidth(px) {
  document.documentElement.style.setProperty('--sidebar-width', px + 'px');
}
function clampSidebarWidth(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 300 : Math.min(500, Math.max(180, n));
}
cfgSidebarWidth.addEventListener('input', () => {
  const v = clampSidebarWidth(cfgSidebarWidth.value);
  cfgSidebarWidthNum.value = v;
  applySidebarWidth(v);
});
cfgSidebarWidthNum.addEventListener('input', () => {
  const v = clampSidebarWidth(cfgSidebarWidthNum.value);
  cfgSidebarWidth.value = v;
  applySidebarWidth(v);
});
cfgSidebarWidthNum.addEventListener('change', () => {
  const v = clampSidebarWidth(cfgSidebarWidthNum.value);
  cfgSidebarWidthNum.value = v;
  cfgSidebarWidth.value    = v;
  applySidebarWidth(v);
});

// Data folder browse / open
document.getElementById('cfg-browseDataDir').addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) cfgDataDir.value = p;
});
document.getElementById('cfg-openDataDir').addEventListener('click', () => {
  const p = cfgDataDir.value.trim();
  if (p) window.api.openFolder(p);
});

cfgBrowseDir.addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) cfgDefaultDir.value = p;
});
cfgClearDir.addEventListener('click', () => { cfgDefaultDir.value = ''; });

cfgBrowseTempDir.addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) cfgTempDir.value = p;
});
cfgClearTempDir.addEventListener('click', () => { cfgTempDir.value = ''; });

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Priority UI
// ═══════════════════════════════════════════════════════════════════════════════

// Returns the current order for a given list element as an array of tool names.
function getToolOrder(listId) {
  return [...document.querySelectorAll(`#${listId} .tool-order-item`)]
    .map(el => el.dataset.tool);
}

// Rebuilds rank numbers and disables arrows at the edges.
function refreshToolOrderUI(listId) {
  const items = [...document.querySelectorAll(`#${listId} .tool-order-item`)];
  items.forEach((item, idx) => {
    item.querySelector('.tool-order-rank').textContent = idx + 1;
    item.querySelector('[data-dir="up"]').disabled   = idx === 0;
    item.querySelector('[data-dir="down"]').disabled = idx === items.length - 1;
  });
}

// Wire up ▲ / ▼ buttons inside each list.
function initToolOrderList(listId) {
  const list = document.getElementById(listId);
  if (!list) return;

  list.addEventListener('click', e => {
    const btn = e.target.closest('.tool-arrow-btn');
    if (!btn) return;
    const item = btn.closest('.tool-order-item');
    const dir  = btn.dataset.dir;
    if (dir === 'up' && item.previousElementSibling) {
      list.insertBefore(item, item.previousElementSibling);
    } else if (dir === 'down' && item.nextElementSibling) {
      list.insertBefore(item.nextElementSibling, item);
    }
    refreshToolOrderUI(listId);
  });

  refreshToolOrderUI(listId);
}

// Apply a saved order array (e.g. ['megacmd','megatools']) to a list.
function applyToolOrder(listId, order) {
  if (!order || !order.length) return;
  const list  = document.getElementById(listId);
  if (!list) return;
  const items = {};
  list.querySelectorAll('.tool-order-item').forEach(el => { items[el.dataset.tool] = el; });
  // Re-append in the saved order (skip unknown tool names gracefully)
  order.forEach(tool => { if (items[tool]) list.appendChild(items[tool]); });
  // Any tools not mentioned in the saved order go at the end
  Object.values(items).forEach(el => { if (!order.includes(el.dataset.tool)) list.appendChild(el); });
  refreshToolOrderUI(listId);
}

initToolOrderList('toolOrder-create');
initToolOrderList('toolOrder-upload');
initToolOrderList('toolOrder-refresh');
initToolOrderList('toolOrder-view');

async function doSaveSettings() {
  const templateVal      = document.getElementById('cfg-postTemplate').value;
  const titleTemplateVal = document.getElementById('cfg-titleTemplate').value;
  const data = {
    proxy:              cfgProxy.value.trim(),
    dataDir:            cfgDataDir.value.trim(),
    defaultOutputDir:   cfgDefaultDir.value.trim(),
    tempDir:            cfgTempDir.value.trim(),
    splitSizeGb:          parseInt(cfgSplitSizeGb.value, 10) || 5,
    splitThresholdGb:     parseFloat(cfgSplitThresholdGb.value)   || 19.5,
    accountThresholdGb:   parseFloat(cfgAccountThresholdGb.value) || 19.5,
    signupEmailSource:   document.querySelector('input[name="cfg-signupEmailSource"]:checked').value,
    downloadThreads:    parseInt(cfgDlThreads.value, 10),
    downloadChunkSize:  parseInt(document.getElementById('cfg-dlChunkSize').value, 10),
    streamingChunkSize: Math.min(1000, Math.max(1, parseInt(cfgStreamingChunkSize.value, 10) || 100)),
    streamMethod:       document.getElementById('cfg-streamMethod').value,
    launchWhenReady:    !!(document.getElementById('cfg-launchWhenReady')?.checked),
    uploadWorkers:      parseInt(document.getElementById('cfg-uploadWorkers').value, 10),
    uploadChunkSize:    parseInt(document.getElementById('cfg-uploadChunkSize').value, 10),
    uploadBufferSize:   parseInt(document.getElementById('cfg-uploadBufferSize').value, 10),
    boostEnabled:         !!(document.getElementById('cfg-boostEnabled')?.checked),
    smartOrderingDefault:   !!(document.getElementById('cfg-smartOrderingDefault')?.checked),
    biSmartOrderingDefault: !!(document.getElementById('cfg-biSmartOrderingDefault')?.checked),
    megacmdConnections: parseInt(cfgMegacmdConnections.value, 10),
    theme:              activeTheme,
    presetName:         activePresetName,
    postTemplate:       templateVal,
    titleTemplate:      titleTemplateVal,
    linkRowTemplate:    (document.getElementById('cfg-linkRowTemplate').value || '').trim(),
    omdbApiKey:         (document.getElementById('cfg-omdbKey').value || '').trim(),
    toolOrderCreate:    getToolOrder('toolOrder-create'),
    toolOrderUpload:    getToolOrder('toolOrder-upload'),
    toolOrderRefresh:   getToolOrder('toolOrder-refresh'),
    toolOrderView:      getToolOrder('toolOrder-view'),
    defaultTab:         (document.getElementById('cfg-defaultTab').value || 'download'),
      sidebarWidth:       clampSidebarWidth(cfgSidebarWidthNum.value),
      linksPerPage:       parseInt(cfgLinksPerPage?.value, 10) || 50,
      accountsPerPage:    parseInt(cfgAccountsPerPage?.value, 10) || 50,
      dormantRefreshCount: Math.max(1, parseInt(document.getElementById('cfg-dormantRefreshCount')?.value, 10) || 10),
      inactiveDays: Math.max(1, parseInt(document.getElementById('cfg-inactiveDays')?.value, 10) || 90),
      downloadsPerPage:   parseInt(cfgDownloadsPerPage?.value, 10) || 50,
      mediaInfoPerPage:   parseInt(cfgMediaInfoPerPage?.value, 10) || 50,
      importsPerPage:     parseInt(cfgImportsPerPage?.value, 10) || 50,
      micHistoryPerPage:  parseInt(cfgMicHistoryPerPage?.value, 10) || 50,
  };
  if (window._setUpLinksPerPage) window._setUpLinksPerPage(data.linksPerPage);
  if (window._setUpAccountsPerPage) window._setUpAccountsPerPage(data.accountsPerPage);
  dlHistoryPerPage = data.downloadsPerPage;
  if (window._setUpMediaInfoPerPage) window._setUpMediaInfoPerPage(data.mediaInfoPerPage);
  if (window._setUpImportsPerPage) window._setUpImportsPerPage(data.importsPerPage);
  if (window._setMicHistoryPerPage) window._setMicHistoryPerPage(data.micHistoryPerPage);
  postTemplate    = templateVal      || DEFAULT_POST_TEMPLATE;
  titleTemplate   = titleTemplateVal || DEFAULT_TITLE_TEMPLATE;
  linkRowTemplate = (document.getElementById('cfg-linkRowTemplate').value || '').trim() || DEFAULT_LINK_ROW_TEMPLATE;
  // #2 Warn if a custom font field has a value that isn't found on this system
  const sansCustomVal = (document.getElementById('cfg-sansCustom').value || '').trim();
  const monoCustomVal = (document.getElementById('cfg-monoCustom').value || '').trim();
  const unverifiedFonts = [];
  if (sansCustomVal && !isFontAvailable(sansCustomVal)) unverifiedFonts.push(`"${sansCustomVal}" (interface)`);
  if (monoCustomVal && !isFontAvailable(monoCustomVal)) unverifiedFonts.push(`"${monoCustomVal}" (monospace)`);
  if (unverifiedFonts.length) {
    showToast(`⚠ Font not found on this system: ${unverifiedFonts.join(', ')} — settings saved anyway`, 6000);
  }
  try {
    const vpn = window.vpnSettings?.readDraft();
    if (vpn) data.vpn = vpn;
    data.rforkUpload = window.rforkSettingsUI.readDraft();
    await window.api.saveConfig(data);
    await window.vpnSettings?.saved();
  } catch (error) {
    showToast(error.message || 'Settings could not be saved.', 6000);
    return;
  }
  updateHealthPill();
  if (window._syncSidebarToolOrders) window._syncSidebarToolOrders(data);
  dataDirPath = data.dataDir || '';
  if (data.defaultOutputDir) outDirInput.value = data.defaultOutputDir;
  // Unlock tabs if the user just set a data folder
  setTabsLocked(!data.dataDir, !data.proxy);
  [cfgSave, cfgSaveTop].forEach(btn => {
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save settings'; }, 1800);
  });
}
cfgSave.addEventListener('click', doSaveSettings);
cfgSaveTop.addEventListener('click', doSaveSettings);

// ═══════════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════════
async function init() {
  renderQueue();
  dlRenderLiveQueue();

  const cfg = await window.api.loadConfig();
  document.querySelector('input[name="cfg-signupEmailSource"][value="' +
    (cfg.signupEmailSource === 'cloudflare' ? 'cloudflare' : 'temp-mail') + '"]').checked = true;

  // Data folder and proxy must be set before tabs are usable
  cfgDataDir.value = cfg.dataDir || '';
  dataDirPath = cfg.dataDir || '';
  const hasDataDir = !!(cfg.dataDir || '').trim();
  const hasProxy = !!(cfg.proxy || '').trim();
  setTabsLocked(!hasDataDir, !hasProxy);

  // Restore the default startup tab selector in Settings UI
  const defaultTabEl = document.getElementById('cfg-defaultTab');
  if (defaultTabEl && cfg.defaultTab) defaultTabEl.value = cfg.defaultTab;

  if (!hasDataDir || !hasProxy) {
    // Open straight to Settings so the user sees the requirements immediately
    openSettingsTab();
  } else {
    // Navigate to the user's preferred default tab
    const preferredTab = cfg.defaultTab || 'download';
    const tabBtn = document.querySelector(`.tab[data-tab="${preferredTab}"]`);
    if (tabBtn) tabBtn.click();
  }

  // Network / defaults
  cfgProxy.value      = cfg.proxy           || '';
  cfgDefaultDir.value = cfg.defaultOutputDir || '';
  cfgTempDir.value       = cfg.tempDir          || '';
  cfgSplitSizeGb.value        = cfg.splitSizeGb        || 5;
  cfgSplitThresholdGb.value   = cfg.splitThresholdGb   || 19.5;
  cfgAccountThresholdGb.value = cfg.accountThresholdGb || 19.5;
  if (cfg.defaultOutputDir) outDirInput.value = cfg.defaultOutputDir;

  // Integrations
  const omdbKeyEl = document.getElementById('cfg-omdbKey');
  if (omdbKeyEl) omdbKeyEl.value = cfg.omdbApiKey || '';

  // Download performance
  const savedThreads = parseInt(cfg.downloadThreads, 10);
  if (savedThreads >= 1 && savedThreads <= 16) {
    cfgDlThreads.value    = savedThreads;
    cfgDlThreadsVal.textContent = String(savedThreads);
  }
  const savedChunk = String(cfg.downloadChunkSize || '');
  if (savedChunk) {
    const opt = document.querySelector(`#cfg-dlChunkSize option[value="${savedChunk}"]`);
    if (opt) opt.selected = true;
  }
  const savedStreamingChunk = parseInt(cfg.streamingChunkSize, 10);
  if (savedStreamingChunk >= 10 && savedStreamingChunk <= 1000) {
    cfgStreamingChunkSize.value = savedStreamingChunk;
  }
  const launchWhenReadyEl = document.getElementById('cfg-launchWhenReady');
  if (launchWhenReadyEl) launchWhenReadyEl.checked = !!(cfg.launchWhenReady);

  // Stream Mode Method setup
  const isLinux = navigator.userAgent.toLowerCase().includes('linux') && !navigator.userAgent.toLowerCase().includes('android');
  if (!isLinux) {
    cfgStreamMethod.value = 'http';
    cfgStreamMethod.disabled = true;
    cfgStreamMethod.title = 'Sparse file mode is only supported on Linux';
  } else {
    cfgStreamMethod.value = cfg.streamMethod || 'http';
  }

  window.rforkSettingsUI.apply(cfg.rforkUpload);

  // megatools upload performance
  const savedWorkers = parseInt(cfg.uploadWorkers, 10);
  if (savedWorkers >= 1 && savedWorkers <= 100) {
    cfgUploadWorkers.value          = savedWorkers;
    cfgUploadWorkersVal.textContent = String(savedWorkers);
  }
  const boostEl = document.getElementById('cfg-boostEnabled');
  if (boostEl) boostEl.checked = (cfg.boostEnabled !== false); // default true
  const smartOrderingDefaultEl = document.getElementById('cfg-smartOrderingDefault');
  if (smartOrderingDefaultEl) smartOrderingDefaultEl.checked = !!(cfg.smartOrderingDefault);
  const upSmartOrderingEl = document.getElementById('up-smartOrdering');
  if (upSmartOrderingEl) upSmartOrderingEl.checked = !!(cfg.smartOrderingDefault);
  const biSmartOrderingDefaultEl = document.getElementById('cfg-biSmartOrderingDefault');
  if (biSmartOrderingDefaultEl) biSmartOrderingDefaultEl.checked = !!(cfg.biSmartOrderingDefault);
  const biSmartOrderingEl = document.getElementById('bi-smartOrdering');
  if (biSmartOrderingEl) biSmartOrderingEl.checked = !!(cfg.biSmartOrderingDefault);

  const savedUpChunk = String(cfg.uploadChunkSize || '');
  if (savedUpChunk) {
    const opt = document.querySelector(`#cfg-uploadChunkSize option[value="${savedUpChunk}"]`);
    if (opt) opt.selected = true;
  }
  const savedUpBuf = String(cfg.uploadBufferSize || '');
  if (savedUpBuf) {
    const opt = document.querySelector(`#cfg-uploadBufferSize option[value="${savedUpBuf}"]`);
    if (opt) opt.selected = true;
  }
  const savedMegacmdConns = parseInt(cfg.megacmdConnections, 10);
  if (savedMegacmdConns >= 1 && savedMegacmdConns <= 100) {
    cfgMegacmdConnections.value          = savedMegacmdConns;
    cfgMegacmdConnectionsVal.textContent = String(savedMegacmdConns);
  }

  // Theme — restore saved or fall back to Lavender Mist
  const savedSidebarWidth = clampSidebarWidth(cfg.sidebarWidth || 340);
  cfgSidebarWidth.value    = savedSidebarWidth;
  cfgSidebarWidthNum.value = savedSidebarWidth;
  applySidebarWidth(savedSidebarWidth);

  // Links subtab pagination — restore saved per-page count (default 50)
  const savedLinksPerPage = parseInt(cfg.linksPerPage, 10);
  const linksPerPageVal   = (savedLinksPerPage >= 1) ? savedLinksPerPage : 50;
  if (window._setUpLinksPerPage) window._setUpLinksPerPage(linksPerPageVal);
  if (cfgLinksPerPage) cfgLinksPerPage.value = linksPerPageVal;

  // Accounts subtab pagination — restore saved per-page count (default 50)
  const savedAccountsPerPage = parseInt(cfg.accountsPerPage, 10);
  const accountsPerPageVal   = (savedAccountsPerPage >= 1) ? savedAccountsPerPage : 50;
  if (window._setUpAccountsPerPage) window._setUpAccountsPerPage(accountsPerPageVal);
  if (cfgAccountsPerPage) cfgAccountsPerPage.value = accountsPerPageVal;

  // Dormant threshold — restore saved days (default 90)
  const inactiveDaysEl = document.getElementById('cfg-inactiveDays');
  if (inactiveDaysEl) {
    const savedInactiveDays = parseInt(cfg.inactiveDays, 10);
    inactiveDaysEl.value = (savedInactiveDays >= 1) ? savedInactiveDays : 90;
  }

  // Dormant batch refresh — restore saved count (default 10)
  const dormantRefreshCountEl = document.getElementById('cfg-dormantRefreshCount');
  if (dormantRefreshCountEl) {
    const savedDormantCount = parseInt(cfg.dormantRefreshCount, 10);
    dormantRefreshCountEl.value = (savedDormantCount >= 1) ? savedDormantCount : 10;
  }

  // Downloaded Files pagination — restore saved per-page count (default 50)
  const savedDownloadsPerPage = parseInt(cfg.downloadsPerPage, 10);
  dlHistoryPerPage = (savedDownloadsPerPage >= 1) ? savedDownloadsPerPage : 50;
  if (cfgDownloadsPerPage) cfgDownloadsPerPage.value = dlHistoryPerPage;

  // MediaInfo subtab pagination — restore saved per-page count (default 50)
  const savedMediaInfoPerPage = parseInt(cfg.mediaInfoPerPage, 10);
  const mediaInfoPerPageVal   = (savedMediaInfoPerPage >= 1) ? savedMediaInfoPerPage : 50;
  if (window._setUpMediaInfoPerPage) window._setUpMediaInfoPerPage(mediaInfoPerPageVal);
  if (cfgMediaInfoPerPage) cfgMediaInfoPerPage.value = mediaInfoPerPageVal;

  // Imported Links subtab pagination — restore saved per-page count (default 50)
  const savedImportsPerPage = parseInt(cfg.importsPerPage, 10);
  const importsPerPageVal   = (savedImportsPerPage >= 1) ? savedImportsPerPage : 50;
  if (window._setUpImportsPerPage) window._setUpImportsPerPage(importsPerPageVal);
  if (cfgImportsPerPage) cfgImportsPerPage.value = importsPerPageVal;

  // Mediainfo Checker history pagination — restore saved per-page count (default 50)
  const savedMicHistoryPerPage = parseInt(cfg.micHistoryPerPage, 10);
  const micHistoryPerPageVal   = (savedMicHistoryPerPage >= 1) ? savedMicHistoryPerPage : 50;
  if (window._setMicHistoryPerPage) window._setMicHistoryPerPage(micHistoryPerPageVal);
  if (cfgMicHistoryPerPage) cfgMicHistoryPerPage.value = micHistoryPerPageVal;

  if (cfg.theme) {
    activeTheme     = { ...PRESETS[0].theme, ...cfg.theme };
    activePresetName = cfg.presetName || '';
  } else {
    activeTheme      = { ...PRESETS[0].theme };
    activePresetName = PRESETS[0].name;
  }

  // Apply theme immediately so app looks right before settings tab is opened
  applyTheme(activeTheme);

  // Build settings UI (after theme is set so swatches show correct colours)
  buildColorPickers();
  buildPresetButtons();
  populateFontControls(activeTheme);

  // Post template — restore saved value or use default
  postTemplate = cfg.postTemplate || DEFAULT_POST_TEMPLATE;
  const templateArea = document.getElementById('cfg-postTemplate');
  if (templateArea) templateArea.value = postTemplate;

  // Title template — restore saved value or use default
  titleTemplate = cfg.titleTemplate || DEFAULT_TITLE_TEMPLATE;
  const titleInputEl = document.getElementById('cfg-titleTemplate');
  if (titleInputEl) titleInputEl.value = titleTemplate;

  // Part row template — restore saved value or use default
  linkRowTemplate = cfg.linkRowTemplate || DEFAULT_LINK_ROW_TEMPLATE;
  const linkRowInputEl = document.getElementById('cfg-linkRowTemplate');
  if (linkRowInputEl) linkRowInputEl.value = linkRowTemplate;

  buildTemplateUI();

  // Restore saved tool priority orders
  if (cfg.toolOrderCreate)  applyToolOrder('toolOrder-create',  cfg.toolOrderCreate);
  if (cfg.toolOrderUpload)  applyToolOrder('toolOrder-upload',  cfg.toolOrderUpload);
  if (cfg.toolOrderRefresh) applyToolOrder('toolOrder-refresh', cfg.toolOrderRefresh);
  if (cfg.toolOrderView)    applyToolOrder('toolOrder-view',    cfg.toolOrderView);

  // Show the app version (read from package.json via the main process)
  try {
    const aboutVer = document.getElementById('aboutVersion');
    if (aboutVer) aboutVer.textContent = await window.api.getAppVersion();
  } catch {
    const aboutVer = document.getElementById('aboutVersion');
    if (aboutVer) aboutVer.textContent = 'unknown';
  }

  // Sync the sidebar tool-priority chips with the saved settings order
  if (window._syncSidebarToolOrders) window._syncSidebarToolOrders(cfg);

  // Update the account refresh reminder from the CSV.
  updateHealthPill();
}

// ── Account refresh reminder ───────────────────────────────────────────────────
// Reads account_log.csv via IPC (no network) and updates the header pill.
document.getElementById('healthPill')?.addEventListener('click', () => {
  document.querySelector('.tab[data-tab="upload"]')?.click();
  document.getElementById('up-tabAccounts')?.click();
});

async function updateHealthPill() {
  const pill   = document.getElementById('healthPill');
  const label  = document.getElementById('healthText');
  if (!pill || !label) return;
  try {
    const { total, refreshCount, thresholdDays } = await window.api.checkAccountsHealth();
    pill.style.display = '';
    if (total === 0) {
      pill.className    = 'status-pill';
      label.textContent = 'No accounts';
      pill.title = 'No accounts in the account log.';
      return;
    }
    const threshold = `Refresh threshold: ${thresholdDays} days.`;
    if (refreshCount > 0) {
      pill.className    = 'status-pill health-refresh';
      label.textContent = `Refresh needed: ${refreshCount}`;
      pill.title = `${refreshCount} account(s) need refreshing. ${threshold}`;
    } else {
      pill.className    = 'status-pill health-active';
      label.textContent = 'Up to date';
      pill.title = `No accounts need a routine refresh. ${threshold}`;
    }
  } catch {
    // If the check fails just hide the pill gracefully
    const pill = document.getElementById('healthPill');
    if (pill) pill.style.display = 'none';
  }
}
