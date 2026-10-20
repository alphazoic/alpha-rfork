'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Post Template engine
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_POST_TEMPLATE =
`[center]{{OMDB Poster}}
[b][size=150][url='/search.php?keywords={{OMDB imdbID}}&sk=x']{{OMDB Title}} ({{OMDB Year}})[/url][/size][/b]
[url=https://www.imdb.com/title/{{OMDB imdbID}}][img]https://i.imgur.com/rcSipDw.png[/img][/url][size=150][b]{{OMDB Rating}}[/b]/10[/size]
[size=150][img]https://i.imgur.com/sEpKj3O.png[/img]{{OMDB Votes}}[/size][/center]
[hr][/hr][size=200][color=#fac51c][b]Plot:[/b][/color][/size]

{{OMDB Plot}}

{{OMDB Info Block}}

[hr][/hr][size=200][color=#fac51c][b]Media Info:[/b][/color][/size]

[mediainfo]{{mediainfo}}
[/mediainfo]
[size=200][color=#fac51c][B]Download Links:[/B][/COLOR][/size]

[center]
[hide][b]{{Links Block}}
[/b][/hide][/CENTER]`;

const DEFAULT_TITLE_TEMPLATE    = '[MEGA] {{File Name Plain}} [{{File Size}}]';
const DEFAULT_LINK_ROW_TEMPLATE = '[url={{Part Link}}][size=150][color=#FF0000]{{Part Label}}[/color][/size][/url] — {{Part Name}} ({{Part Size}})';

let postTemplate     = DEFAULT_POST_TEMPLATE;
let titleTemplate    = DEFAULT_TITLE_TEMPLATE;
let linkRowTemplate  = DEFAULT_LINK_ROW_TEMPLATE;

// All template variable tokens (order determines chip display order)
const LINK_ROW_VARS = [
  '{{Part Number}}',
'{{Part Label}}',
'{{Part Link}}',
'{{Part Name}}',
'{{Part Size}}',
];

const TEMPLATE_VARS = [
  '{{mediainfo}}',
  '{{File Name}}',
  '{{File Name Plain}}',
  '{{File Size}}',
  '{{File Link}}',
  '{{Links Block}}',    // formatted list of all selected links (single or multi)
  '{{Folder Link}}',
  '{{Email}}',
  '{{Password}}',
  '{{Last Login Date}}',
  // OMDB variables — populated when user links a title via the 🎬 search on a Generated Link
  '{{OMDB Title}}',
  '{{OMDB Year}}',
  '{{OMDB Plot}}',
  '{{OMDB Genre}}',
  '{{OMDB Director}}',
  '{{OMDB Actors}}',
  '{{OMDB Rating}}',
  '{{OMDB Runtime}}',
  '{{OMDB imdbID}}',
  '{{OMDB Poster}}',    // expands to a [img]…[/img] BBCode tag
  '{{OMDB imdbLink}}',  // expands to a [url=…][img]IMDB badge[/img][/url] BBCode tag
  '{{OMDB Votes}}',     // raw imdbVotes string, e.g. "1,234,567"
  '{{OMDB Info Block}}',// full BBCode movie-info section (genre, cast, runtime, etc.)
];

// Builds the full BBCode movie-info section from an OMDB response object.
// This is what {{OMDB Info Block}} expands to.
function buildOmdbInfoBlock(d) {
  if (!d || d.Response === 'False') return '';
  const rows = [];
  if (d.Rated      && d.Rated      !== 'N/A') rows.push(`[*][B]Rating: [/B] ${d.Rated}`);
  if (d.Genre      && d.Genre      !== 'N/A') rows.push(`[*][B]Genre: [/B] ${d.Genre}`);
  if (d.Director   && d.Director   !== 'N/A') rows.push(`[*][B]Directed By: [/B] ${d.Director}`);
  if (d.Writer     && d.Writer     !== 'N/A') rows.push(`[*][B]Written By: [/B] ${d.Writer}`);
  if (d.Actors     && d.Actors     !== 'N/A') rows.push(`[*][B]Starring: [/B] ${d.Actors}`);
  if (d.Released   && d.Released   !== 'N/A') rows.push(`[*][B]Release Date: [/B] ${d.Released}`);
  if (d.Runtime    && d.Runtime    !== 'N/A') rows.push(`[*][B]Runtime: [/B] ${d.Runtime}`);
  if (d.Production && d.Production !== 'N/A') rows.push(`[*][B]Production: [/B] ${d.Production}`);
  if (!rows.length) return '';
  return `\n[hr][/hr][size=200][color=#fac51c][b]Movie Info:[/b][/color][/size]\n\n[LIST]${rows.join('\n')}[/LIST]\n`;
}

// ── Archive-part detection ─────────────────────────────────────────────────────
// Matches filenames like:  movie.mkv.7z.001, movie.rar, movie.part2.rar, movie.zip.003
// Returns { baseName, ext, partNum } or null if not an archive part.
const ARCHIVE_PART_RE = /^(.+?)(\.7z\.\d{3}|\.part\d+\.rar|\.zip\.\d{3}|\.r\d{2,3})$/i;

function parseArchivePart(fileName) {
  const m = (fileName || '').match(ARCHIVE_PART_RE);
  if (!m) return null;
  const suffix = m[2];
  // Extract numeric part number from the suffix
  const numMatch = suffix.match(/(\d+)/);
  return { baseName: m[1], ext: suffix, partNum: numMatch ? parseInt(numMatch[1], 10) : 0 };
}

// Strips archive-part suffixes to get the logical base name.
// e.g. "movie.mkv.7z.001" → "movie.mkv", "movie.mkv" → "movie.mkv"
function archiveBaseName(fileName) {
  const parsed = parseArchivePart(fileName);
  return parsed ? parsed.baseName : fileName;
}

// Groups an array of link entries by archive base name.
// Returns Map<baseName, entry[]> — entries with no archive suffix are keyed by their own name.
function groupByArchive(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = archiveBaseName(entry.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  // Sort parts within each group by part number
  for (const [, items] of groups) {
    if (items.length > 1) {
      items.sort((a, b) => {
        const pa = parseArchivePart(a.name);
        const pb = parseArchivePart(b.name);
        return (pa ? pa.partNum : 0) - (pb ? pb.partNum : 0);
      });
    }
  }
  return groups;
}

// Builds the {{Links Block}} BBCode string from an array of { name, link, size } items.
// Single item: renders like the original single-link format.
// Multiple items: renders a numbered list of links with sizes.
function buildLinksBlock(items, rowTemplate) {
  if (!items || items.length === 0) return '';
  const tmpl = rowTemplate || linkRowTemplate || DEFAULT_LINK_ROW_TEMPLATE;
  return items.map((item, i) => {
    const partNumber = String(i + 1);
    const partLabel  = items.length === 1 ? 'MEGA' : `Part ${partNumber}`;
    return tmpl
    .replace(/\{\{Part Number\}\}/g, partNumber)
    .replace(/\{\{Part Label\}\}/g,  partLabel)
    .replace(/\{\{Part Link\}\}/g,   item.link || '')
    .replace(/\{\{Part Name\}\}/g,   (item.name || '').replace(/\.[^/.]+$/, ''))
    .replace(/\{\{Part Size\}\}/g,   item.size || '');
  }).join('\n');
}

// Substitutes {{variable}} tokens in `template` with values from `fileData`,
// the pre-formatted mediainfo text string, and optional OMDB API response data.
// `linksBlockItems` is an optional array of { name, link, size } for {{Links Block}}.
// When omitted, {{Links Block}} renders using the single fileData item.
function renderPostTemplate(template, fileData, miText, omdbData, linksBlockItems) {
  // Build the links block — if no explicit items provided, use the single fileData
  const lbItems = linksBlockItems || [{ name: fileData.name, link: fileData.link, size: fileData.size }];
  const linksBlock = buildLinksBlock(lbItems);

  let result = template
    .replace(/\{\{mediainfo\}\}/g,        miText || '')
    .replace(/\{\{File Name\}\}/g,        fileData.name        || '')
    .replace(/\{\{File Name Plain\}\}/g,  (fileData.name || '').replace(/\.[^/.]+$/, ''))
    .replace(/\{\{File Size\}\}/g,        fileData.size        || '')
    .replace(/\{\{File Link\}\}/g,        fileData.link        || '')
    .replace(/\{\{Links Block\}\}/g,      linksBlock)
    .replace(/\{\{Folder Link\}\}/g,      fileData.folderLink  || '')
    .replace(/\{\{Email\}\}/g,            fileData.email       || '')
    .replace(/\{\{Password\}\}/g,         fileData.password    || '')
    .replace(/\{\{Last Login Date\}\}/g,  fileData.lastLogin   || '');

  // ── OMDB substitutions ──────────────────────────────────────────────────────
  if (omdbData && omdbData.Response !== 'False') {
    const d       = omdbData;
    const def     = (v) => (v && v !== 'N/A') ? v : '';
    const posterBB  = def(d.Poster)  ? `[img]${d.Poster}[/img]`  : '';
    const imdbBB    = def(d.imdbID)  ? `[url=https://www.imdb.com/title/${d.imdbID}][img]https://i.imgur.com/rcSipDw.png[/img][/url]` : '';
    result = result
      .replace(/\{\{OMDB Title\}\}/g,       def(d.Title))
      .replace(/\{\{OMDB Year\}\}/g,        def(d.Year))
      .replace(/\{\{OMDB Plot\}\}/g,        def(d.Plot))
      .replace(/\{\{OMDB Genre\}\}/g,       def(d.Genre))
      .replace(/\{\{OMDB Director\}\}/g,    def(d.Director))
      .replace(/\{\{OMDB Actors\}\}/g,      def(d.Actors))
      .replace(/\{\{OMDB Rating\}\}/g,      def(d.imdbRating))
      .replace(/\{\{OMDB Runtime\}\}/g,     def(d.Runtime))
      .replace(/\{\{OMDB imdbID\}\}/g,      def(d.imdbID))
      .replace(/\{\{OMDB Poster\}\}/g,      posterBB)
      .replace(/\{\{OMDB imdbLink\}\}/g,    imdbBB)
      .replace(/\{\{OMDB Votes\}\}/g,       def(d.imdbVotes))
      .replace(/\{\{OMDB Info Block\}\}/g,  buildOmdbInfoBlock(d));
  } else {
    // No OMDB data — silently erase any OMDB placeholders so the post isn't full of raw tokens
    result = result.replace(/\{\{OMDB [^}]+\}\}/g, '');
  }

  return result;
}

// Renders a post template using multiple selected items.
// Merges data: first item is primary (provides file metadata, OMDB, etc.),
// all items contribute to {{Links Block}}, sizes are summed for {{File Size}}.
async function renderMultiPostTemplate(template, selectedItems, omdbCacheMap) {
  if (!selectedItems || selectedItems.length === 0) return '';

  // Smart fallback: If user's customized template doesn't include the new {{Links Block}}
  // but has the old {{File Link}}, automatically swap it out so multi-links render correctly
  // instead of just rendering the top post's link repeatedly.
  if (!template.includes('{{Links Block}}') && template.includes('{{File Link}}')) {
    // Try to replace a full BBCode URL tag containing the token first
    template = template.replace(/\[url=['"]?\{\{File Link\}\}['"]?\].*?\[\/url\]/gi, '{{Links Block}}');
    // Fallback: replace just the raw token if not inside a url tag
    if (!template.includes('{{Links Block}}')) {
      template = template.replace(/\{\{File Link\}\}/gi, '{{Links Block}}');
    }
  }

  const primary = selectedItems[0];

  // Sum total size — parse human-readable sizes back to bytes for summing, then format
  let totalSizeStr = primary.size || '';
  if (selectedItems.length > 1) {
    const allSizes = selectedItems.map(i => i.size || '').filter(Boolean);
    if (allSizes.length > 0) {
      // Parse human-readable size strings (GiB, MiB, GB, MB, etc.) back to bytes, sum, then reformat
      const parseToBytes = str => {
        const m = str.trim().match(/^([\d.]+)\s*([KMGT]i?B|B)$/i);
        if (!m) return 0;
        const val = parseFloat(m[1]);
        const unit = m[2].replace(/\u202F/g, '').toUpperCase();
        const map = { B: 1, KB: 1024, KIB: 1024, MB: 1048576, MIB: 1048576, GB: 1073741824, GIB: 1073741824, TB: 1099511627776, TIB: 1099511627776 };
        return val * (map[unit] || 1);
      };
      const totalBytes = allSizes.reduce((sum, s) => sum + parseToBytes(s), 0);
      totalSizeStr = totalBytes > 0 ? fmtBytes(totalBytes) : allSizes.join(' + ');
    }
  }

  // Use archive base name for the primary file name if this is a split group
  const baseName = archiveBaseName(primary.name);

  // Collect mediainfo — use the first item that has any
  let miText = '';
  try {
    const records = await window.api.readMediaInfo();
    for (const item of selectedItems) {
      const record = records.find(r => r.fileLink === item.link) || records.find(r => r.fileName === item.name);
      if (record && typeof record.mediainfo === 'string' && record.mediainfo.trim()) {
        miText = record.mediainfo;
        break;
      }
    }
  } catch { /* non-fatal */ }

  // OMDB data — use first match from any selected item
  let omdbData = null;
  for (const item of selectedItems) {
    if (omdbCacheMap.has(item.link)) { omdbData = omdbCacheMap.get(item.link); break; }
  }

  // Build the primary fileData for the template
  const fileData = {
    name: baseName,
    link: primary.link,
    size: totalSizeStr,
    email: primary.email || '',
    password: primary.password || '',
    folderLink: primary.folderLink || '',
    lastLogin: primary.lastLogin || '',
  };

  // Build items for {{Links Block}}
  const lbItems = selectedItems.map(i => ({ name: i.name, link: i.link, size: i.size || '' }));

  return renderPostTemplate(template, fileData, miText, omdbData, lbItems);
}

