/* Mark Calculator
 * Everything runs in the browser. Modules and marks are saved in localStorage,
 * so nothing is uploaded to a server.
 *
 * A module has assessments and (optionally) groups. A group is a part of the final
 * mark such as "Practical mark 16%": the assessments inside it are weighted as a
 * percentage of the group, and the group as a percentage of the final mark.
 */

const STORAGE_KEY = "markCalc.v1";

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ---------- State ----------

let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.modules)) return upgradeState(saved);
  } catch (e) { /* ignore */ }
  return { modules: [], folders: [], selectedId: null, uploadFolderId: null };
}

// Older saves have no groups or folders yet
function upgradeState(s) {
  s.modules.forEach(m => (m.groups = m.groups || []));
  s.folders = Array.isArray(s.folders) ? s.folders : [];
  s.modules.forEach(m => { if (!s.folders.some(f => f.id === m.folderId)) m.folderId = null; });
  if (!s.folders.some(f => f.id === s.uploadFolderId)) s.uploadFolderId = null;
  return s;
}

// Framework text kept per module for "Read again with AI" (dropped if the browser runs out of space)
const SOURCE_TEXT_LIMIT = 80000;

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Out of space: the saved framework texts are the only thing we can do without
    try {
      state.modules.forEach(m => delete m.sourceText);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e2) {
      console.warn("Could not save", e2);
    }
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function currentModule() {
  return state.modules.find(m => m.id === state.selectedId) || null;
}

// ---------- Reading files ----------

async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    if (!window.pdfjsLib) throw new Error("PDF reader did not load. Check your internet connection.");
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      lines.push(...groupPdfItemsIntoLines(content.items));
    }
    return lines.join("\n");
  }

  if (ext === "docx") {
    if (!window.mammoth) throw new Error("Word reader did not load. Check your internet connection.");
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    return wordHtmlToLines(result.value).join("\n");
  }

  return await file.text();
}

// Marks the end of a Word paragraph, so the rules finder knows where sentences end
const PARA_END = "\u2029";

// One line per paragraph, and one line per table row with its cells separated by COL,
// so a row like "Test 1 | Sit down | 10 March | 40%" stays together.
function wordHtmlToLines(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = [];
  const clean = s => s.replace(/\s+/g, " ").trim();
  // A cell can hold several paragraphs; keep a space between them
  const cellText = td => {
    const parts = [...td.querySelectorAll("p, li")].map(p => clean(p.textContent)).filter(Boolean);
    return parts.length ? parts.join(" ") : clean(td.textContent);
  };
  const walk = el => {
    for (const child of el.children) {
      if (child.tagName === "TABLE") {
        for (const tr of child.querySelectorAll("tr")) {
          if (tr.closest("table") !== child) continue; // rows of a table inside a cell
          const cells = [...tr.children];
          // A table used as a page layout, with the real table inside one of its cells
          if (cells.some(td => td.querySelector("table"))) { cells.forEach(walk); continue; }
          const texts = cells.map(cellText).filter(Boolean);
          if (texts.length) lines.push(texts.join(COL));
        }
      } else if (/^(P|H\d|LI)$/.test(child.tagName)) {
        const text = clean(child.textContent);
        if (text) lines.push(text + PARA_END);
      } else {
        walk(child);
      }
    }
  };
  walk(doc.body);
  return lines;
}

// PDF text comes as loose pieces; put pieces with the same height on the page on one line
// so that table rows like "Test 1 ..... 20%" stay together. Pieces that touch are one word
// ("4" + "7 %" is "47 %"), and a wide gap between pieces is a table column, marked with COL.
const COL = " ¦ ";

function groupPdfItemsIntoLines(items) {
  const rows = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.hypot(item.transform[0], item.transform[1]) || 10;
    let row = rows.find(r => Math.abs(r.y - y) < 3);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, size, width: item.width || 0, str: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    const parts = r.parts.sort((a, b) => a.x - b.x);
    let line = "";
    parts.forEach((p, i) => {
      if (i > 0) {
        const prev = parts[i - 1];
        const gap = p.x - (prev.x + prev.width);
        if (gap > 8) line += COL;
        else if (gap > p.size * 0.12 || /\s$/.test(prev.str) || /^\s/.test(p.str)) line += " ";
      }
      line += p.str;
    });
    return line.replace(/[ \t]+/g, " ").trim();
  });
}

// ---------- Finding assessments in the text ----------

// Lines that mention a percentage but are rules, not assessments
const SKIP_LINE = /(minimum|pass\s?mark|admission|at least|must (obtain|achieve|pass)|requires?\b|required|or higher|or more|plagiari|attendance|late submission|penalt|deduct|similarity|turnitin|exemption|supplementary|distinction|notional|competency|replace|optional|opsioneel|missed|if applicable)/i;
const SKIP_NAME = /^(total|totals|weight|weighting|percentage|contribution|mark|marks|final mark|assessment|description)$/i;
const PCT = /(\d{1,3}(?:[.,]\d+)?)\s*%/g;
// A table header announcing a weight column, e.g. "Assessment | Content | Weighting (%)"
const WEIGHT_HEADER = /\b(weight(ing)?|gewig|percentage)\b/i;

function parseFramework(text) {
  const lines = text.split(/\r?\n/)
    .map(l => l
      .split(PARA_END).join("")
      .replace(/https?:\/\/\S+|www\.\S+/gi, " ")   // web links ("%20" is not a weight)
      .replace(/\S*%[0-9A-Fa-f]{2}\S*/g, " ")       // pieces of links broken over lines
      .replace(/\t| {2,}/g, COL)                    // tabs / wide spaces are table columns
      .replace(/ +/g, " ")
      .trim())
    .filter(l => l && l !== COL.trim());

  const found = [];
  const groups = [];
  const equations = [];
  const seen = new Set();
  const year = frameworkYear(text);
  const dates = [];          // { label, date } found in assessment rows
  let rowContext = {};       // the current line and the lines above it, to find a row's date
  let recent = [];
  let group = null;          // group the next rows belong to ("Practical mark" ... "Total 100%")
  let weightColumn = 0;      // lines left in which a bare number at the end of a row is a weight
  let marksRows = 0;         // lines left in which "Essay questions | 50 | marks" is a part of the group

  const startGroup = name => {
    group = { id: uid(), name: tidy(name.replace(/¦/g, " ")), weight: 0, byMarks: false };
    groups.push(group);
    recent = [];
    marksRows = 12;
  };
  const groupTotal = g => found.filter(a => a.groupId === g.id).reduce((s, a) => s + a.weight, 0);

  const add = (name, weight, count = 1) => {
    if (!name || SKIP_NAME.test(name)) return;
    if (/^[a-z]/.test(name)) return; // the rest of a sentence from the line above, not a name
    if (name.split(" ").length > 10) return; // a long sentence, probably not an assessment row
    if (weight === 100 && /total|final|module mark/i.test(name)) return;
    // "Class mark 40%" after the class mark's own table: that is the group's weight, not an assessment
    if (groups.some(g => norm(g.name) === norm(name))) { group = null; addRow(name, weight, null); return; }
    // "Predikaat (Klaspunt) 100%" heads a group
    if (weight === 100) { startGroup(name); return; }
    for (let i = 1; i <= count; i++) addRow(count > 1 ? `${singular(name)} ${i}` : name, weight, group);
    // A group is complete once its parts add up to 100%
    if (group && !group.byMarks && groupTotal(group) >= 99.5) group = null;
  };
  const addRow = (name, weight, g) => {
    const key = name.toLowerCase() + "|" + weight + "|" + (g ? g.id : "");
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ id: uid(), name, weight, mark: "", isFinal: false, groupId: g ? g.id : null });
    // The row's own line first; the lines above it only for tables with one cell per line
    const d = findDate(rowContext.line, year) || findDate(rowContext.above, year);
    if (d) dates.push({ label: name, date: d.iso });
  };

  for (const line of lines) {
    rowContext = { line, above: recent.join(" ¦ ") };
    const flat = line.replace(/¦/g, " ").replace(/\s+/g, " ").replace(/^[◼■▪●•\s]+/, "").trim();

    // "Tests (2 x 40%) = 80%"  and  "+ (7 x Tut tests) = 20%"
    const times = flat.match(/^\+?\s*([A-Za-z][A-Za-z ]*?)?\s*\(\s*(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*%\s*\)\s*=?\s*(\d+(?:[.,]\d+)?)?\s*%?$/i);
    if (times && times[1]) { add(capitalize(tidy(times[1])), parseFloat(times[3].replace(",", ".")), parseInt(times[2], 10)); continue; }
    const timesNamed = flat.match(/^\+?\s*\(\s*(\d+)\s*x\s*([A-Za-z][A-Za-z ]*?)\s*\)\s*=\s*(\d+(?:[.,]\d+)?)\s*%$/i);
    if (timesNamed) { add(`${capitalize(tidy(timesNamed[2]))} (${timesNamed[1]})`, parseFloat(timesNamed[3].replace(",", "."))); continue; }

    // "Predikaatpunt: Eksamenpunt 40%:60%"
    const ratio = flat.match(/^([A-Za-z][A-Za-z ()]*?)\s*:\s*([A-Za-z][A-Za-z ()]*?)\s+(\d{1,3})\s*%?\s*:\s*(\d{1,3})\s*%?\.?$/);
    if (ratio) { addRatio(equations, ratio[1], ratio[2], ratio[3], ratio[4]); continue; }

    if (/^total\b/i.test(flat)) { group = null; recent = []; continue; }
    if (line.includes("=")) { collectEquations(line, equations); continue; }

    const matches = [...line.matchAll(PCT)];
    const hasLetters = /[a-z]/i.test(line.replace(PCT, ""));

    if (!matches.length) {
      if (WEIGHT_HEADER.test(line) && line.includes("¦")) { weightColumn = 15; continue; }

      const bare = weightColumn > 0 && line.match(/¦\s*(\d{1,3}(?:[.,]\d+)?)\s*$/);
      if (bare) {
        const w = parseFloat(bare[1].replace(",", "."));
        if (w > 0 && w <= 100) { add(cleanName(line.slice(0, bare.index)), w); weightColumn = 15; continue; }
      }
      weightColumn--;

      // Inside a group, parts given in marks: "Longer essay type questions | 50 | marks"
      const marks = group && marksRows > 0 && flat.match(/^(?:(.*[A-Za-z].*?)\s+)?(\d{1,3})\s*marks$/i);
      if (marks) {
        const name = marks[1] ? cleanName(line.replace(/¦?\s*\d{1,3}\s*¦?\s*marks\s*$/i, "")) : cleanName(recent[recent.length - 1] || "");
        if (name && !/^[a-z]/.test(name)) {
          group.byMarks = true;
          addRow(name, parseInt(marks[2], 10), group);
          recent = [];
          marksRows = 12;
          continue;
        }
      }
      marksRows--;

      if (hasLetters && isGroupHeader(line)) { startGroup(line); continue; }
      // Remember short text lines: in Word tables the name and weight are often on separate lines
      if (hasLetters && line.length <= 100) {
        recent.push(line);
        if (recent.length > 8) recent.shift();
      }
      continue;
    }

    // "Twee klastoetse (30% elk) 60%": several assessments with the same weight
    const each = flat.match(/^([A-Za-z][A-Za-z ]*?)\s*\(\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:each|elk)\s*\)/i);
    if (each && !SKIP_LINE.test(flat)) {
      const { count, name } = splitCount(each[1]);
      const w = parseFloat(each[2].replace(",", "."));
      const total = flat.slice(each[0].length).match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
      const n = count || (total ? Math.round(parseFloat(total[1].replace(",", ".")) / w) : 1);
      add(capitalize(tidy(name)), w, n);
      recent = [];
      continue;
    }

    // In a table, the weight has a column of its own; a percentage inside a long text cell is prose
    const pctCell = line.split("¦").find(c => /\d\s*%/.test(c)) || "";
    // Check the name and weight for rules, but not a comments column after the weight:
    // "Test 1 | 40% | A subminimum of 40% is required" is still an assessment
    const upToWeight = line.slice(0, line.indexOf(pctCell) + pctCell.length);
    if (SKIP_LINE.test(upToWeight)) { recent = []; continue; }
    // A full sentence ("The exam contributes 50% to your final mark.") usually repeats a table row
    if (/\.$/.test(pctCell) && pctCell.split(" ").length > 6) continue;
    // The rest of a formula that didn't fit on one line ("semester mark) + 60% theory exam mark")
    if (pctCell.includes("+")) continue;
    if (pctCell.replace(PCT, " ").trim().split(/\s+/).length > 6) continue;

    const weight = parseFloat(matches[0][1].replace(",", "."));
    if (!(weight > 0 && weight <= 100)) continue;

    add(hasLetters ? cleanName(line) : pickLabel(recent), weight);
    recent = [];
  }

  // Weights written out in sentences (frameworks without a table)
  readSentences(lines.map(l => l.replace(/¦/g, " ")).join(" ").replace(/\s+/g, " "), found, groups, equations);

  const usedGroups = settleGroups(found, groups, equations, lines);
  const notes = dropSecondOpportunities(found, usedGroups);
  markLikelyFinal(found, usedGroups);
  // (only spaces are trimmed: trim() would also remove the paragraph-end mark)
  const ruleLines = text.split(/\r?\n/)
    .map(l => l.replace(/https?:\/\/\S+|www\.\S+/gi, " ").replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter(l => l.replace(PARA_END, "").trim());
  return { assessments: found, groups: usedGroups, notes, rules: findRules(ruleLines), dates: collectDates(lines, dates, year) };
}

// ---------- Key dates ----------

const MONTHS = {
  jan: 1, january: 1, januarie: 1, feb: 2, february: 2, februarie: 2, mar: 3, march: 3, maart: 3,
  apr: 4, april: 4, may: 5, mei: 5, jun: 6, june: 6, junie: 6, jul: 7, july: 7, julie: 7,
  aug: 8, august: 8, augustus: 8, sep: 9, sept: 9, september: 9, oct: 10, okt: 10, october: 10, oktober: 10,
  nov: 11, november: 11, dec: 12, des: 12, december: 12, desember: 12,
};

// The year the framework is for: the year mentioned most often (else this year)
function frameworkYear(text) {
  const counts = {};
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? Number(best[0]) : new Date().getFullYear();
}

function isoDate(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// The first date in a piece of text: "31 August", "07 April 2026", "October 2", "17/08/2026", "2026-11-13"
function findDate(s, year) {
  s = String(s).replace(/¦/g, " ");
  const tries = [
    [/\b(20\d{2})-(\d{2})-(\d{2})\b/, m => isoDate(m[1], m[2], m[3])],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/, m => isoDate(m[3], m[2], m[1])],
    [/\b(\d{1,2})(?:st|nd|rd|th)?\s*-?\s*([A-Za-z]{3,10})\.?,?(?:\s+(20\d{2}))?(?![\w])/, m => MONTHS[m[2].toLowerCase()] && isoDate(m[3] || year, MONTHS[m[2].toLowerCase()], m[1])],
    [/\b([A-Za-z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*[:h%])(?:,?\s+(20\d{2}))?/, m => MONTHS[m[1].toLowerCase()] && isoDate(m[3] || year, MONTHS[m[1].toLowerCase()], m[2])],
  ];
  let best = null;
  for (const [re, make] of tries) {
    for (const m of s.matchAll(new RegExp(re.source, "gi"))) {
      const iso = make(m);
      if (iso && (!best || m.index < best.index)) { best = { iso, index: m.index }; break; }
    }
  }
  return best;
}

// Dates of assessments from the rows, plus lines like "Practical test: Thursday 15 October, 14h00"
// or "First opportunity – 14/11/2026", or a schedule row "Fri, 21 Aug | TEST | ASSESSMENT A1.1".
const NOT_A_DATE_LINE = /(updated|opgedateer|maintenance|version|weergawe|copyright|holiday|vakansie|class free|follows a|consultation|published|printed|\bgeen\b)/i;
const DATE_LABEL_WORD = /(opportunit|geleentheid|due|deadline|submission|inhandig|closes)/i;
// Class sessions in a schedule, not assessments: "NO PRACTICALS", "TUTORIAL 1 GROUP 3A", "Test review in class"
const SESSION_LABEL = /\b(no|review|introduction|handing out|uitdeel|lecture|lesing|demo)\b|\bgroups?\s*\d|tutorial$/i;
const isSessionLabel = label =>
  SESSION_LABEL.test(label) || (/\b(tutorials?|practicals?|praktika)\b/i.test(label) && !/\b(test|quiz|toets|assessment|exam|report|due)\b/i.test(label));

function collectDates(lines, rowDates, year) {
  const out = [...rowDates];
  const has = iso => out.some(d => d.date === iso);
  for (const line of lines) {
    if (NOT_A_DATE_LINE.test(line)) continue;
    const flat = line.replace(/¦/g, " ").replace(/\s+/g, " ").replace(/^[◼■▪●•\s]+/, "").trim();
    const d = findDate(flat, year);
    if (!d || has(d.iso)) continue;
    // "Practical test: Thursday 15 October" -> "Practical test"
    let label = flat.slice(0, d.index)
      .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*$/i, "")
      .replace(/\b(date|datum|on|op)\s*$/i, "")
      .replace(/[\s:–—\-,@(]+$/, "").trim();
    if (!(label && label.split(" ").length <= 8 && (ASSESSMENT_WORD.test(label) || DATE_LABEL_WORD.test(label)))) {
      // A schedule row: the short cell that names an assessment
      const cell = line.split("¦").map(c => c.trim())
        .filter(c => c.split(/\s+/).length <= 6 && (ASSESSMENT_WORD.test(c) || /\bA\d(\.\d)?\b/.test(c)) && !findDate(c, year))
        .sort((a, b) => /\bA\d/.test(b) - /\bA\d/.test(a))[0];
      label = cell || "";
    } else if (line.includes("¦")) {
      // In a table row, just the cell that names the assessment ("Reflection", not its description)
      const cell = line.split("¦").map(c => c.trim())
        .find(c => (ASSESSMENT_WORD.test(c) || DATE_LABEL_WORD.test(c)) && !findDate(c, year));
      if (cell && cell.split(/\s+/).length <= 8) label = cell;
    }
    label = tidy(label.replace(/\bdue\s*date\b/i, "due"));
    if (!label || label.length < 3 || isSessionLabel(label)) continue;
    // "First opportunity" on its own is an exam date
    if (/^(first|second|third|1st|2nd|3rd|\d)\s*(exam\s*)?opportunit/i.test(label)) label = `Exam, ${label.toLowerCase()}`;
    out.push({ label: capitalize(label), date: d.iso });
  }
  return out
    .filter((d, i) => out.findIndex(x => x.date === d.date) === i) // one event per day
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 25)
    .map(d => ({ id: uid(), label: d.label.slice(0, 60), date: d.date }));
}

// Words that show a line is an assessment's name, and lines that are only a date or a time
const ASSESSMENT_WORD = /\b(assessments?|tests?|toetse?|exams?|eksamen|examination|assignments?|taak|take|opdrag|projects?|projek|quiz(zes)?|vasvrae?|tutorials?|tutoriale?|practicals?|prakties|praktika|reports?|verslag|essays?|presentations?|portfolio|participation|deelname|reflection|proposal)\b/i;
const CODE_WORD = /\b[A-Z]{1,4}\d+[A-Z0-9.]*\b/;
const DATE_OR_TIME = /^(\d{1,2}[\s/.-]+[A-Za-z]+[\s/.-]+\d{2,4}|\d{1,2}\s+[A-Za-z]+$|\d{1,2}[:h]\d{2}|(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b)/i;

// When the weight has a line of its own, the name is one of the lines above it:
// "Assessment 1 Semester 1 (A1S1) / Test / 07 April 2026 / 17:40 / 15%"
function pickLabel(recent) {
  // Short lines only: a wrapped sentence above the table is not a name
  const lines = recent.map(l => l.trim())
    .filter(l => l && !DATE_OR_TIME.test(l) && l.split("¦")[0].trim().split(/\s+/).length <= 10);
  if (!lines.length) return "";
  const first = l => l.split("¦")[0];
  // The assessment code closest to the weight, e.g. "Assessment 1 Semester 1 (A1S1)"
  const coded = lines.filter(l => CODE_WORD.test(first(l))).pop();
  if (coded) {
    if (ASSESSMENT_WORD.test(first(coded))) return cleanName(coded);
    // "Semester 1 (AFS1): / Tutorial tests during lectures" -> "Tutorial tests during lectures (AFS1)"
    const code = first(coded).match(CODE_WORD)[0];
    const named = lines.slice(lines.indexOf(coded) + 1).filter(l => ASSESSMENT_WORD.test(first(l))).pop();
    return named ? `${cleanName(named)} (${code})` : cleanName(coded);
  }
  return cleanName(lines.find(l => ASSESSMENT_WORD.test(l.split("¦")[0])) || lines[lines.length - 1]);
}

// A3, supplementary exams and sick tests only replace a missed or failed assessment.
// If counting them pushes the total over 100%, leave them out and say so.
const SECOND_OPPORTUNITY = /\bA3\b|assessment 3\b|supplementar|sick test|siektetoets|re-?exam|second (exam )?opportunity|tweede geleentheid|herkans|replacement/i;

function dropSecondOpportunities(found, groups) {
  const share = a => effectiveWeight({ groups }, a);
  const total = found.reduce((s, a) => s + share(a), 0);
  const extra = found.filter(a => !a.groupId && SECOND_OPPORTUNITY.test(a.name));
  const extraTotal = extra.reduce((s, a) => s + share(a), 0);
  if (!extra.length || total <= 100.5 || Math.abs(total - extraTotal - 100) > 0.5) return [];
  extra.forEach(a => found.splice(found.indexOf(a), 1));
  return extra.map(a => `${a.name} (${fmt(a.weight, 2)}%) is a second opportunity: it only replaces an assessment you missed or failed, so it isn't counted in your final mark here. If you write it, check your framework for how it replaces the other marks.`);
}

// Sentences that set rules for passing: sub-minimums, exam entry, how A3 works ...
const RULE = /(sub-?\s?minimum|minimum (class )?(mark|of|average|requirement)|at least \d{1,3}\b|\d{1,3}\s*% or (higher|more|above)|(exam|examination) (entry|access|admission)|access to (the )?(exam|A3)|qualify|pass requirement|required to pass|is required to|in order to (pass|write)|must be (obtained|achieved)|capped|highest of|will replace|replaces|count only)/i;
const AFRIKAANS = /\b(die|van|word|nie|vir|moet|punt|sal|hierdie|indien|eksamen)\b/gi;

function findRules(lines) {
  // Read the left column and the right column separately, so two-language PDFs stay readable.
  // A bullet in its own column ("• | text") isn't a column, and neither is a line with
  // one word per column ("A | MINIMUM | CLASS | MARK").
  const paraEnds = lines.map(l => l.endsWith(PARA_END));
  const cleaned = lines.map(l => l.replace(PARA_END, "").replace(/^\s*([•◼■▪●o\-]|\d+[.)])\s*¦\s*/, "• "));
  const wordPerCell = l => l.split("¦").every(c => c.trim().split(/\s+/).length <= 2);
  const left = cleaned.map(l => (wordPerCell(l) ? l.replace(/¦/g, " ") : l.split("¦")[0]).trim());
  const right = cleaned.map(l => (wordPerCell(l) ? "" : l.split("¦").slice(1).join(" ")).trim());

  const sentences = [];
  for (const column of [left, right]) {
    // A line much shorter than the others, or ending in . : ! ?, ends a paragraph or a heading
    const lengths = column.filter(Boolean).map(l => l.length).sort((a, b) => a - b);
    const typical = lengths[Math.floor(lengths.length / 2)] || 60;
    let paragraph = "";
    column.forEach((l, i) => {
      if (!l) return;
      paragraph = paragraph ? `${paragraph} ${l}` : l;
      if (paraEnds[i] || /[.!?:]$/.test(l) || l.length < typical * 0.6) {
        sentences.push(...paragraph.split(/(?<=[.!?])\s+(?=[A-Z])|\s+•\s+/));
        paragraph = "";
      }
    });
    if (paragraph) sentences.push(...paragraph.split(/(?<=[.!?])\s+(?=[A-Z])|\s+•\s+/));
  }

  const rules = [];
  const seen = new Set();
  for (let s of sentences) {
    s = s.replace(/^[•◼■▪●\-\s]+/, "").replace(/\s+/g, " ").trim();
    if (/\.{4,}/.test(s)) continue; // table of contents
    if (s.length < 25 || s.length > 320 || /https?:|www\./i.test(s) || !RULE.test(s)) continue;
    if (!/^[A-Z0-9]/.test(s)) continue; // the end of a sentence cut off by a page or column break
    if (s.split(" ").length < 6 || /notional|credit value/i.test(s)) continue; // headings, study hours
    if ((s.match(AFRIKAANS) || []).length >= 3) continue; // the Afrikaans copy of an English rule
    const key = s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(s);
    if (rules.length >= 12) break;
  }
  return rules;
}

// Short heading lines like "Theory semester mark" or "Practical mark" start a group
function isGroupHeader(line) {
  const words = line.replace(/¦/g, " ").trim().split(/\s+/);
  return /\b(mark|punt)\b/i.test(line) && words.length <= 5;
}

const COUNT_WORDS = { a: 1, an: 1, one: 1, een: 1, two: 2, twee: 2, three: 3, drie: 3, four: 4, vier: 4,
  five: 5, vyf: 5, six: 6, ses: 6, seven: 7, sewe: 7, eight: 8, agt: 8 };

// "three class tests" -> { count: 3, name: "class tests" }
function splitCount(s) {
  const m = s.trim().match(/^(\w+)\s+(.+)$/);
  if (m) {
    const n = COUNT_WORDS[m[1].toLowerCase()] || (/^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 0);
    if (n) return { count: n, name: m[2] };
  }
  return { count: 0, name: s.trim() };
}

// "class tests" -> "Class test", "klastoetse" -> "Klastoets"
function singular(name) {
  const t = name.trim();
  const s = /toetse$/i.test(t) ? t.replace(/toetse$/i, "toets") : t.replace(/([^s])s$/i, "$1");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// Same thing, loosely: "Predikaatpunt" and "Predikaat (Klaspunt)", "class mark" and "Class Mark"
function sameName(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.split(" ").length <= nb.split(" ").length ? [na, nb] : [nb, na];
  const longWords = long.split(" ");
  return short.split(" ").every(w => longWords.some(l =>
    l === w || (w.length >= 4 && l.length >= 4 && (l.startsWith(w) || w.startsWith(l)))));
}

// "Predikaatpunt : Eksamenpunt 40% : 60%" -> final = 40% predikaat + 60% eksamen
function addRatio(equations, a, b, pa, pb) {
  const x = parseFloat(pa), y = parseFloat(pb);
  if (Math.abs(x + y - 100) > 0.5 || equations.some(e => e.lhs === "final")) return;
  equations.push({ lhs: "final", terms: [
    { pct: x, raw: a.trim(), key: norm(a) },
    { pct: y, raw: b.trim(), key: norm(b) },
  ] });
}

// Frameworks that explain the weights in sentences instead of a table
function readSentences(text, found, groups, equations) {
  // "The final mark is determined by 40:60 of the class mark and the examination mark."
  const ratio = text.match(/\b(?:final (?:module )?mark|finale (?:module ?)?punt|module mark)\b[^.]{0,60}?\b(\d{1,3})\s*%?\s*:\s*(\d{1,3})\s*%?\s+(?:of\s+)?(?:the\s+|die\s+)?([A-Za-z][A-Za-z ]{2,40}?)\s+(?:and|en)\s+(?:the\s+|die\s+)?([A-Za-z][A-Za-z ]{2,40}?)\s*[.,;]/i);
  if (ratio) addRatio(equations, ratio[3], ratio[4], ratio[1], ratio[2]);

  // "The class mark will be made up of three class tests (20% each), one written assignment (20%) and ..."
  const re = /\b((?:[A-Za-z]+\s+){0,2}?(?:mark|punt))\s+(?:will\s+be\s+|is\s+)?(?:made up of|consists? of|comprises?|composed of|bestaan uit)\s+([^.]{5,300}?%[^.]*?)\./gi;
  for (const m of text.matchAll(re)) {
    const name = capitalize(m[1].replace(/^the\s+/i, "").trim());
    if (groups.some(g => norm(g.name) === norm(name))) continue;
    const rows = [];
    for (const item of m[2].split(/,\s*|\s+and\s+|\s+en\s+/)) {
      const im = item.match(/^\s*(.+?)\s*\(\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:each|elk)?\s*\)/i);
      if (!im) continue;
      const { count, name: itemName } = splitCount(im[1]);
      const w = parseFloat(im[2].replace(",", "."));
      const n = count || 1;
      for (let i = 1; i <= n; i++) rows.push({ name: n > 1 ? `${singular(itemName)} ${i}` : capitalize(itemName.trim()), weight: w });
    }
    if (Math.abs(rows.reduce((s, r) => s + r.weight, 0) - 100) > 0.5) continue;
    const g = { id: uid(), name, weight: 0, byMarks: false };
    groups.push(g);
    rows.forEach(r => found.push({ id: uid(), name: tidy(r.name), weight: r.weight, mark: "", isFinal: false, groupId: g.id }));
  }
}

// Keep only real groups (2+ rows adding up to 100% of the group) and work out what
// each group counts towards the final mark.
function settleGroups(found, groups, equations, lines) {
  const rowsOf = g => found.filter(a => a.groupId === g.id);
  const round = n => Math.round(n * 10000) / 10000;

  // Parts given in marks (100 + 50 + 50 marks) become percentages of the group
  for (const g of groups.filter(g => g.byMarks)) {
    const rows = rowsOf(g);
    const total = rows.reduce((s, a) => s + a.weight, 0);
    if (total > 0) rows.forEach(a => (a.weight = round((a.weight / total) * 100)));
  }

  const real = groups.filter(g => {
    const rows = rowsOf(g);
    const total = rows.reduce((s, a) => s + a.weight, 0);
    const ok = rows.length >= 2 && Math.abs(total - 100) < 0.5;
    if (!ok) rows.forEach(a => (a.groupId = null));
    return ok;
  });
  real.forEach(g => delete g.byMarks);

  // "Class mark (Coursework) 40%" listed on its own gives the group's weight
  for (const g of real) {
    const row = found.find(a => !a.groupId && norm(a.name) === norm(g.name));
    if (row) { g.weight = row.weight; found.splice(found.indexOf(row), 1); }
  }

  // Otherwise, formulas such as "Final module mark = 40% class mark + 60% theory exam mark"
  if (real.some(g => !g.weight)) {
    const resolved = resolveEquations(equations, real, found, lines);
    if (resolved) {
      real.forEach(g => { if (!g.weight) g.weight = resolved.groupWeights[g.id]; });
      resolved.rowWeights.forEach(([a, w]) => (a.weight = w));
      found.push(...resolved.extra);
    }
  }

  // No group weights anywhere and the rows already add up to 100%: no groups needed
  if (!real.some(g => g.weight > 0)) {
    const flatTotal = found.reduce((s, a) => s + a.weight, 0);
    if (!real.length || Math.abs(flatTotal - 100) < 0.5) {
      found.forEach(a => (a.groupId = null));
      return [];
    }
  }
  return real;
}

// "Class mark = 40% practical mark + 60% theory semester mark"
function collectEquations(line, equations) {
  for (const cell of line.split("¦")) {
    const m = cell.match(/^\s*(?:\d+\)\s*)?([A-Za-z][A-Za-z ]{2,40}?)\s*=\s*([^=()]+)$/);
    if (!m) continue;
    const terms = m[2].split("+").map(t =>
      t.match(/^\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?([A-Za-z][A-Za-z ]*?)\s*\.?\s*$/));
    if (terms.length < 2 || terms.some(t => !t)) continue;
    const parsed = terms.map(t => ({ pct: parseFloat(t[1].replace(",", ".")), raw: t[2], key: norm(t[2]) }));
    if (Math.abs(parsed.reduce((s, t) => s + t.pct, 0) - 100) > 0.5) continue;
    const lhs = norm(m[1]);
    if (!equations.some(e => e.lhs === lhs)) equations.push({ lhs, terms: parsed });
  }
}

function resolveEquations(equations, groups, found, lines) {
  const root = equations.find(e => /^(final module|final|module|final module calculated)$/.test(e.lhs));
  if (!root) return null;

  const groupWeights = {};
  const rowWeights = [];
  const extra = [];
  const round = n => Math.round(n * 10000) / 10000;

  const expand = (key, raw, factor, depth) => {
    const eq = depth < 5 && equations.find(e => e.lhs === key);
    if (eq) {
      eq.terms.forEach(t => expand(t.key, t.raw, (factor * t.pct) / 100, depth + 1));
      return;
    }
    const g = groups.find(g => norm(g.name) === key) || groups.find(g => sameName(g.name, raw || key));
    if (g) { groupWeights[g.id] = round(factor * 100); return; }
    const a = found.find(a => !a.groupId && norm(a.name) === key);
    if (a) { rowWeights.push([a, round(factor * 100)]); return; }
    // Only named in a formula, e.g. "60% theory exam mark": add it as an assessment
    extra.push({ id: uid(), name: nameFromFormula(raw, lines), weight: round(factor * 100), mark: "", isFinal: false, groupId: null });
  };
  expand(root.lhs, "", 1, 0);

  if (groups.some(g => !g.weight && !groupWeights[g.id])) return null;
  return { groupWeights, rowWeights, extra };
}

// "theory exam mark" -> "Theory exam (A2)" when the framework says "Theory exam mark (A2 assessment)"
function nameFromFormula(raw, lines) {
  let name = raw.replace(/\bmarks?\b/i, "").replace(/(\w{3,})punt\b/i, "$1").trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  const re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(\\s*(A\\d+(?:\\.\\d+)?)", "i");
  for (const l of lines) {
    const m = l.match(re);
    if (m) return `${name} (${m[1].toUpperCase()})`;
  }
  return name;
}

function norm(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(mark|marks|the|punt|punte)\b/g, " ")
    .replace(/\b([a-z]{3,})punt\b/g, "$1")   // Afrikaans "klaspunt" = class mark
    .replace(/\s+/g, " ")
    .trim();
}

// In a table row, the name is the first column with words in it. An assessment code
// column next to it (A1, A1.2, A2 ...) is kept, other columns (dates, venues) are dropped.
function cleanName(s) {
  // Some PDFs put every word in its own column: "Class | mark | (Coursework) | 40%"
  const beforeWeight = s.split("¦").map(c => c.trim()).filter(Boolean);
  const pctAt = beforeWeight.findIndex(c => /\d\s*%/.test(c));
  const lead = pctAt > 0 ? beforeWeight.slice(0, pctAt) : [];
  if (lead.length >= 2 && lead.every(c => !/\s/.test(c) && /[a-z]/i.test(c))) return tidy(lead.join(" "));

  const cells = s.replace(PCT, " ").split("¦").map(c => c.trim()).filter(Boolean);
  const first = cells.findIndex(c => /[a-z]/i.test(c));
  if (first === -1) return "";
  let name = cells[first];
  // Bilingual names: "Test 1 / Toets 1" -> "Test 1"
  const halves = name.split(/\s*\/\s*/);
  if (halves.length === 2 && halves.every(h => /[a-z]{2}/i.test(h))) {
    // "Test/Toets 1": the number is only written once, after the Afrikaans
    const num = !/\d/.test(halves[0]) && halves[1].match(/\s(\d+(?:\.\d+)?)\s*$/);
    name = halves[0] + (num ? " " + num[1] : "");
  }
  const code = cells.slice(first + 1).find(c => /^A\d+(\.\d+)?\.?$/i.test(c));
  if (code && !name.includes(code.replace(/\.$/, ""))) name += ` (${code.replace(/\.$/, "")})`;
  return tidy(name);
}

function tidy(s) {
  return s
    .replace(/\b(weight(ing)?|contributes?|contribution|counts?|towards?|of (the )?final mark|of (the )?module mark)\b/gi, " ")
    .replace(/[()\[\]:=|•·–—◼■▪●!*]+/g, " ")
    .replace(/\s-\s/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-.,;\/]+|[\s\-.,;\/]+$/g, "")
    .slice(0, 70);
}

// The last test of the semester: prefer A2 / exam / final, otherwise the last row
function markLikelyFinal(list, groups = []) {
  if (!list.length) return;
  list.forEach(a => (a.isFinal = false));
  const share = a => effectiveWeight({ groups }, a);
  const order = [/\bA2\b/i, /exam|eksamen/i, /\bfinal\b/i, /summative/i];
  const groupName = a => ((a.groupId && groups.find(g => g.id === a.groupId)) || {}).name || "";
  for (const re of order) {
    // An assessment called "Exam", or one inside a group called "Exam mark"
    const hits = list.filter(a => re.test(a.name) || re.test(groupName(a)));
    if (hits.length) {
      // Prefer the one that counts most of the final mark (the theory exam over a practical exam)
      hits.sort((a, b) => share(b) - share(a));
      hits[0].isFinal = true;
      return;
    }
  }
  list[list.length - 1].isFinal = true;
}

// The module code from the file name ("Gen244 Module Framework.pdf" -> "GEN 244"), else the
// first code in the text. Frameworks often mention other modules, so the file name comes first.
function guessModuleName(text, fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const fromFile = base.match(/\b([A-Za-z]{2,10})\s?(\d{3})\b/);
  if (fromFile) {
    const inText = text.match(new RegExp(`\\b${fromFile[1]}\\s?${fromFile[2]}\\b`, "i"));
    return inText ? inText[0].toUpperCase() : fromFile[0];
  }
  // Only a number in the file name ("324 Module Framework.docx"): find its code in the text
  const num = base.match(/\b(\d{3})\b/);
  const withNum = num && [...text.matchAll(new RegExp(`\\b([A-Za-z]{2,10})\\s?${num[1]}\\b`, "g"))]
    .find(m => !/^(module|modules|framework|raamwerk|outline|page|room)$/i.test(m[1]));
  if (withNum) return withNum[0].toUpperCase();
  if (num) return tidyFileName(base);
  const code = text.match(/\b[A-Z]{2,4}\s?\d{3,4}[A-Z]?\b/);
  return code ? code[0] : tidyFileName(base);
}

// "324 Module Framework 2026 Pasture and Veld (1) (2)" -> "324 Pasture and Veld"
function tidyFileName(base) {
  return base
    .replace(/\b(module|framework|outline|raamwerk|final)\b|\b20\d\d\b|\(\d+\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || base;
}

// ---------- Calculations ----------

// Accepts "68", "68%", "68,5" or "34/50". Returns a percentage, null if empty, NaN if invalid.
function parseMark(raw) {
  const s = String(raw ?? "").trim().replace(/%$/, "").replace(",", ".");
  if (!s) return null;
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  let pct;
  if (frac) {
    const total = parseFloat(frac[2]);
    pct = total > 0 ? (parseFloat(frac[1]) / total) * 100 : NaN;
  } else {
    pct = /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }
  return pct >= 0 && pct <= 100 ? pct : NaN;
}

const hasMark = r => r.pct !== null && !isNaN(r.pct);

function groupOf(mod, a) {
  return (a.groupId && mod.groups.find(g => g.id === a.groupId)) || null;
}

// Share of the final mark: weight within the group times the group's weight
function effectiveWeight(mod, a) {
  const w = Number(a.weight) || 0;
  const g = groupOf(mod, a);
  return g ? ((Number(g.weight) || 0) * w) / 100 : w;
}

function calculate(mod) {
  const rows = mod.assessments.map(a => ({
    a,
    weight: effectiveWeight(mod, a),
    pct: parseMark(a.mark),
  }));
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const scale = totalWeight > 0 ? 100 / totalWeight : 0; // in case weights don't add up to exactly 100

  let earned = 0, doneWeight = 0;
  for (const r of rows) {
    if (hasMark(r)) {
      earned += (r.pct * r.weight) / 100;
      doneWeight += r.weight;
    }
  }

  const finalRow = rows.find(r => r.a.isFinal) || null;
  const missing = rows.filter(r => r !== finalRow && r.weight > 0 && !hasMark(r));

  let needed = null;
  if (finalRow && finalRow.weight > 0 && !missing.length) {
    const earnedOthers = rows
      .filter(r => r !== finalRow && hasMark(r))
      .reduce((s, r) => s + (r.pct * r.weight) / 100, 0);
    const targetPoints = (Number(mod.target) || 0) / scale;
    needed = ((targetPoints - earnedOthers) / finalRow.weight) * 100;
  }

  // Per group: how much of it is done and the mark so far
  const groupStats = {};
  for (const g of mod.groups) {
    const inGroup = rows.filter(r => r.a.groupId === g.id);
    const inner = inGroup.reduce((s, r) => s + (Number(r.a.weight) || 0), 0);
    const doneRows = inGroup.filter(hasMark);
    const doneInner = doneRows.reduce((s, r) => s + (Number(r.a.weight) || 0), 0);
    const earnedInner = doneRows.reduce((s, r) => s + (r.pct * (Number(r.a.weight) || 0)) / 100, 0);
    groupStats[g.id] = { inner, average: doneInner > 0 ? (earnedInner / doneInner) * 100 : null };
  }

  return {
    rows,
    totalWeight,
    earned,
    finalSoFar: earned * scale,
    doneWeight,
    donePct: doneWeight * scale,
    average: doneWeight > 0 ? (earned / doneWeight) * 100 : null,
    finalRow,
    missing,
    needed,
    groupStats,
  };
}

const fmt = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toString();


// ---------- Saved framework PDFs ----------
// Each uploaded PDF is kept in the browser's IndexedDB (localStorage is too small for files),
// so "Read again with AI" can send the PDF itself. Not part of the backup file.

const FILES_DB = "markCalcFiles";

function openFilesDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILES_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function filesDo(mode, action) {
  try {
    const db = await openFilesDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("files", mode);
      const req = action(tx.objectStore("files"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("Saved files not available", e); // private window, blocked storage...
    return null;
  }
}

const saveFile = (id, blob) => filesDo("readwrite", store => store.put(blob, id));
const loadFile = id => filesDo("readonly", store => store.get(id));
const deleteFile = id => filesDo("readwrite", store => store.delete(id));

// ---------- AI reader (Google Gemini) ----------
// Optional: each student uses their own free Gemini API key, kept only in their own browser
// (not in the backup file). Without a key, or if the AI fails, the built-in reader is used.

const AI_STORAGE_KEY = "markCalc.ai";
const AI_MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash-lite"];
const AI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function loadAi() {
  try { return JSON.parse(localStorage.getItem(AI_STORAGE_KEY)) || {}; } catch (e) { return {}; }
}
function saveAi(settings) {
  try { localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
const aiOn = () => !!loadAi().key;

const AI_INSTRUCTIONS = `You read university module frameworks (module outlines / study guides) and work out exactly how the student's final module mark is calculated. Read the whole document: tables, sentences, footnotes and formulas, in English or Afrikaans.

Return JSON only, following the schema. Rules:
- "assessments": every assessment that counts towards the final mark (tests, exams, assignments, projects, quizzes, tutorials, practicals, reports, participation, etc.). Use the framework's own short name (max 60 characters), with its code if it has one, e.g. "Assessment 1 (A1)" or "Test 2 / A2".
- If the framework says "two tests (30% each)" or "Tests (2 x 40%)", list each test separately.
- If only the best N of M assessments count (e.g. "four tests are written, only the best three (20% each) count"), list only N of them, named like "Class test (best 1)", "Class test (best 2)", and add a rule explaining which ones count. Never list more assessments than actually count, or the weights won't add up.
- Before answering, add up the weights: they must add up exactly as described below. If they don't, re-read the framework and fix your answer.
- Groups: if part of the final mark is made of other assessments (e.g. "Class mark 40% = Test 1 40% + Test 2 40% + Tutorials 20%"), return that part in "groups" with "weightOfFinal" = its share of the final mark, and give each assessment inside it "group" = the group's name and "weight" = its percentage OF THE GROUP. Assessments that count directly towards the final mark have "group" = "" and "weight" = their percentage of the final mark. If groups are nested, flatten them: multiply the percentages so every group's weightOfFinal is its share of the final mark.
- The weightOfFinal of all groups plus the weights of all assessments with no group must add up to 100. The weights inside each group must add up to 100.
- Assessments that only REPLACE others (A3, supplementary or second-opportunity exams, sick tests, optional make-up tests, re-writes) do not go in "assessments". Put them in "notCounted" with a short reason.
- Formative work that doesn't count for marks goes nowhere.
- Exactly one assessment has "isFinal": true: the last main assessment of the semester/year that counts (usually the exam or A2). The student uses it to see what mark they still need.
- "rules": up to 10 short, clear English sentences about passing: sub-minimums, exam entry requirements, what is needed to pass, how replacement assessments (like A3) work, best-of rules, caps. Translate Afrikaans to English. Don't include rules about attendance, plagiarism, late submission or administration unless they change marks.
- "keyDates": every dated assessment event: each test, each exam opportunity (including A2, A3 and supplementary exams), and the due date of each assignment, project, report or other submission. "name" is short (e.g. "Test 1", "Project due", "Exam, first opportunity"), "date" is YYYY-MM-DD. If the year isn't written, use the academic year the framework is for. Leave out lectures, practical or tutorial sessions, holidays, IT maintenance and the date the document was updated. Dates that are "TBA" or "to be confirmed" are left out.
- "moduleName": the module's code and number, e.g. "PP 344" or "Financial Accounting 288".
- Numbers are plain numbers without % signs. Never invent assessments that are not in the document.`;

const AI_SCHEMA = {
  type: "OBJECT",
  properties: {
    moduleName: { type: "STRING" },
    groups: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { name: { type: "STRING" }, weightOfFinal: { type: "NUMBER" } }, required: ["name", "weightOfFinal"] },
    },
    assessments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          weight: { type: "NUMBER" },
          group: { type: "STRING" },
          isFinal: { type: "BOOLEAN" },
        },
        required: ["name", "weight", "group", "isFinal"],
      },
    },
    notCounted: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { name: { type: "STRING" }, weight: { type: "NUMBER" }, reason: { type: "STRING" } }, required: ["name", "reason"] },
    },
    rules: { type: "ARRAY", items: { type: "STRING" } },
    keyDates: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { name: { type: "STRING" }, date: { type: "STRING" } }, required: ["name", "date"] },
    },
  },
  required: ["moduleName", "groups", "assessments", "notCounted", "rules", "keyDates"],
};

// Sends the framework text to Gemini. Tries the next model if one isn't available.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Google's message from an error reply, e.g. "The model is overloaded. Please try again later."
const googleMessage = detail => {
  try { return JSON.parse(detail).error.message || ""; } catch (e) { return ""; }
};

// When Google is busy (500-504) a model is tried 3 times, waiting a little longer each time,
// before moving on to the next model. A used-up free limit (429) is per model, so the next
// model is tried straight away. onStatus(text) reports what's happening.
const BUSY_RETRY_WAITS = [2000, 5000];

async function callGemini(body, onStatus = () => {}) {
  const settings = loadAi();
  if (!settings.key) throw new Error("No AI key saved.");
  const models = [...new Set([settings.model, ...AI_MODELS].filter(Boolean))];
  let busy = false, limited = false, missing = "";
  for (const model of models) {
    for (let attempt = 0; attempt <= BUSY_RETRY_WAITS.length; attempt++) {
      let res;
      try {
        res = await fetch(`${AI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error("Couldn't reach Google. Check your internet connection.");
      }
      if (res.ok) return { data: await res.json(), model };
      const detail = await res.text().catch(() => "");
      if (res.status >= 500 && res.status <= 504) {
        busy = true;
        if (attempt < BUSY_RETRY_WAITS.length) {
          onStatus(`Google's AI is busy, trying again… (${model})`);
          await wait(BUSY_RETRY_WAITS[attempt]);
          continue;
        }
        break; // next model
      }
      if (res.status === 404) { missing = `Model "${model}" isn't available.`; break; }
      if (res.status === 429) { limited = true; onStatus(`Free limit reached for ${model}, trying another model…`); break; }
      if ((res.status === 400 && /api.?key/i.test(detail)) || res.status === 401 || res.status === 403) {
        throw new Error("Google didn't accept the API key. Check that you copied all of it.");
      }
      const msg = googleMessage(detail);
      const err = new Error(`Google returned an error (${res.status})${msg ? `: ${msg}` : "."}`);
      err.status = res.status; // 400/413 for a file Google can't take: aiRead then sends the text instead
      throw err;
    }
  }
  if (busy) throw new Error("Google's AI is too busy right now (error 503). This is on Google's side, not your key. Try again in a few minutes.");
  if (limited) throw new Error("The free AI limit is used up for now. Try again in a minute, or tomorrow.");
  throw new Error(missing || "No AI model is available.");
}

// Weights that don't add up: each group's assessments to 100%, and everything to 100% of the final mark
function weightProblems(groups, assessments) {
  const problems = [];
  for (const g of groups) {
    const inner = assessments.filter(a => a.groupId === g.id).reduce((s, a) => s + a.weight, 0);
    if (Math.abs(inner - 100) > 0.5) problems.push(`The assessments in the group "${g.name}" add up to ${fmt(inner, 2)}% of the group, not 100%.`);
  }
  const total = assessments.reduce((s, a) => s + effectiveWeight({ groups }, a), 0);
  if (Math.abs(total - 100) > 0.5) problems.push(`Everything adds up to ${fmt(total, 2)}% of the final mark, not 100%.`);
  return problems;
}

// Asks the AI to read the framework. If the weights in its answer don't add up,
// it's told what's wrong and asked once more for a corrected answer.
// PDFs up to this size are sent to the AI as the file itself (it sees the pages, not just the text)
const AI_PDF_LIMIT = 15 * 1024 * 1024;

const blobToBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// Reads the framework with the AI: from the PDF itself when there is one, otherwise from its text.
// If Google can't take the PDF, the text is sent instead.
async function aiRead(text, onStatus = () => {}, pdf = null) {
  if (pdf && pdf.size <= AI_PDF_LIMIT) {
    try {
      const data = await blobToBase64(pdf);
      const result = await aiReadParts([
        { inlineData: { mimeType: "application/pdf", data } },
        { text: "This PDF is the module framework. Read every page, including tables, footnotes and both language columns." },
      ], onStatus);
      result.input = "pdf";
      return result;
    } catch (err) {
      if (err.status !== 400 && err.status !== 413) throw err; // busy, limit, bad key: sending text won't help
      console.warn("Gemini couldn't take the PDF, sending the text instead", err);
      onStatus("Google couldn't take the PDF, sending its text instead…");
    }
  }
  const result = await aiReadParts([{ text: "Module framework:\n\n" + text.split(PARA_END).join("").slice(0, 150000) }], onStatus);
  result.input = "text";
  return result;
}

async function aiReadParts(frameworkParts, onStatus) {
  const framework = { role: "user", parts: frameworkParts };
  const ask = async contents => {
    const { data, model } = await callGemini({
      systemInstruction: { parts: [{ text: AI_INSTRUCTIONS }] },
      contents,
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: AI_SCHEMA },
    }, onStatus);
    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    let answer;
    try { answer = JSON.parse(raw); } catch (e) { throw new Error("The AI's answer couldn't be read."); }
    return { result: fromAiAnswer(answer), raw, model };
  };

  let { result, raw, model } = await ask([framework]);
  let problems = weightProblems(result.groups, result.assessments);
  if (problems.length) {
    onStatus("Checking the AI's answer…");
    try {
      const second = await ask([
        framework,
        { role: "model", parts: [{ text: raw }] },
        { role: "user", parts: [{ text: "Your answer has these problems:\n- " + problems.join("\n- ") +
          "\nRe-read the framework. Look for rules like \"only the best N count\", assessments that only replace others, " +
          "and percentages of a group versus percentages of the final mark. Return the complete corrected JSON." }] },
      ]);
      const secondProblems = weightProblems(second.result.groups, second.result.assessments);
      if (secondProblems.length <= problems.length) ({ result, model } = second), (problems = secondProblems);
    } catch (e) {
      console.warn("AI correction failed", e); // keep the first answer
    }
  }
  result.model = model;
  result.problems = problems;
  return result;
}

// The AI's reading, unless its weights still don't add up and the built-in reader's do.
// The AI's rules and notes are kept either way: they're usually clearer.
function chooseReading(aiResult, text) {
  if (!aiResult.problems.length) return { parsed: aiResult, readBy: "ai" };
  const builtIn = parseFramework(text);
  if (!builtIn.assessments.length || weightProblems(builtIn.groups, builtIn.assessments).length) {
    return { parsed: aiResult, readBy: "ai" };
  }
  builtIn.name = aiResult.name;
  if (aiResult.rules.length) builtIn.rules = aiResult.rules;
  if (aiResult.dates.length) builtIn.dates = aiResult.dates;
  builtIn.notes = [
    ...(aiResult.notes.length ? aiResult.notes : builtIn.notes),
    "The AI's weights didn't add up, so the built-in reader's weights are used. Check them against your framework.",
  ];
  return { parsed: builtIn, readBy: "built-in" };
}

// Turns the AI's answer into this site's modules: groups, assessments, notes and rules
function fromAiAnswer(answer) {
  const num = v => parseFloat(String(v ?? "").replace(",", ".")) || 0;
  const groups = (answer.groups || [])
    .filter(g => g && String(g.name || "").trim())
    .map(g => ({ id: uid(), name: String(g.name).trim().slice(0, 70), weight: num(g.weightOfFinal) }));
  const groupFor = name => {
    const n = String(name || "").trim();
    return n ? groups.find(g => norm(g.name) === norm(n)) || groups.find(g => sameName(g.name, n)) : null;
  };
  const assessments = (answer.assessments || [])
    .filter(a => a && String(a.name || "").trim())
    .map(a => ({
      id: uid(),
      name: String(a.name).trim().slice(0, 70),
      weight: num(a.weight),
      mark: "",
      isFinal: !!a.isFinal,
      groupId: groupFor(a.group)?.id || null,
    }));
  if (!assessments.length) throw new Error("The AI didn't find any assessments.");

  const usedGroups = groups.filter(g => assessments.some(a => a.groupId === g.id));
  // Exactly one final test
  const finals = assessments.filter(a => a.isFinal);
  if (finals.length !== 1) markLikelyFinal(assessments, usedGroups);

  const notes = (answer.notCounted || [])
    .filter(n => n && n.name)
    .map(n => `${n.name}${num(n.weight) ? ` (${fmt(num(n.weight), 2)}%)` : ""} isn't counted in your final mark here: ${String(n.reason || "").trim()}`);
  const rules = (answer.rules || []).map(r => String(r).trim()).filter(Boolean).slice(0, 12);
  const dates = (answer.keyDates || [])
    .map(d => {
      const m = String(d?.date || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      const iso = m && isoDate(m[1], m[2], m[3]);
      return iso && String(d.name || "").trim() ? { id: uid(), label: String(d.name).trim().slice(0, 60), date: iso } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 30);
  return { name: String(answer.moduleName || "").trim().slice(0, 60), groups: usedGroups, assessments, notes, rules, dates };
}

// ---------- Screens ----------
// Phone-first screens: the intro, My modules, Key dates, Add a module, Reading the framework,
// Check the weights, the module page, the mark sheet and the delete dialog.
// Only these draw the page; reading frameworks and the calculations above are unchanged.

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
const esc = escapeHtml;

// Line icons (stroke 1.5), drawn inline so they work offline
const ICONS = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  grip: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" stroke-width="2.6"/>',
  sparkles: '<path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9z"/><path d="M19 3v4M17 5h4"/>',
  folderPlus: '<path d="M3 5h6l2 2h10v12H3z"/><path d="M12 10v6M9 13h6"/>',
  camera: '<path d="M14.5 4h-5L7 7H3v13h18V7h-4z"/><circle cx="12" cy="13" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  hand: '<path d="M4 20h16M6 16l9.5-9.5a2.1 2.1 0 0 1 3 3L9 19H6z"/>',
  share: '<path d="M4 12v9h16v-9M16 6l-4-4-4 4M12 2v13"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  calPlus: '<rect x="3" y="4" width="18" height="18"/><path d="M16 2v4M8 2v4M3 10h18M12 13v6M9 16h6"/>',
};
const ic = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r1 = n => fmt(n, settings().decimals);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const reduceMotion = () => !!settings().calm || matchMedia("(prefers-reduced-motion: reduce)").matches;
const buzz = () => haptic(8);
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";

// ---------- Settings ----------
// Saved with the modules (so Backup carries them), except the AI key and Light/Dark, which stay per device.

// Change these with every update, so Settings → About shows which version the phone has
const APP_VERSION = "25";
const APP_UPDATED = "28 Oct 2026";

const SETTING_DEFAULTS = { defaultGoal: 50, risk: 70, decimals: 1, reminder: "day9", calm: false, haptics: true, accent: "blue", glass: "full" };
const settings = () => ({ ...SETTING_DEFAULTS, ...(state.settings || {}) });
function setSetting(key, value) {
  state.settings = { ...settings(), [key]: value };
  saveState();
  applySettings();
}
// Reduce animations, the accent colour and the glass strength (set on the page, so the styles follow)
function applySettings() {
  const s = settings(), root = document.documentElement;
  document.body.classList.toggle("calm", !!s.calm);
  if (s.accent && s.accent !== "blue") root.dataset.accent = s.accent; else delete root.dataset.accent;
  if (s.glass && s.glass !== "full") root.dataset.glass = s.glass; else delete root.dataset.glass;
}

// Calendar reminders for all-day events (they start at midnight): when, and what the reminder says
const REMINDERS = {
  day9: { label: "The day before, 09:00", trigger: "-PT15H", days: 1, hour: 9, text: "Tomorrow" },
  eve: { label: "The evening before, 18:00", trigger: "-PT6H", days: 1, hour: 18, text: "Tomorrow" },
  two: { label: "2 days before, 09:00", trigger: "-P1DT15H", days: 2, hour: 9, text: "In 2 days" },
  week: { label: "A week before, 09:00", trigger: "-P6DT15H", days: 7, hour: 9, text: "In a week" },
  none: { label: "No reminder", trigger: null, text: "" },
};

// A light tap when something is saved. Android vibrates; iPhone Safari doesn't allow vibration,
// but iOS 18 and newer give a small tap when a switch is toggled, so a hidden switch is used there.
const hapticSwitch = (() => {
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
})();
function haptic(pattern = 8) {
  if (!settings().haptics) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
    else hapticSwitch.click();
  } catch (e) { /* ignore */ }
}

function renderSettings() {
  const s = settings();
  document.querySelectorAll("#scrSettings [data-set]").forEach(seg => {
    const key = seg.dataset.set;
    seg.querySelectorAll("button[data-v]").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === Number(s[key])));
  });
  const other = document.querySelector('[data-ch="set-goal-other"]');
  const custom = ![50, 60, 75].includes(Number(s.defaultGoal));
  other.value = custom ? s.defaultGoal : "";
  other.classList.toggle("on", custom);
  document.querySelector('[data-ch="set-risk"]').value = String(s.risk);
  document.querySelector('[data-ch="set-reminder"]').value = s.reminder;
  document.querySelectorAll('#scrSettings [data-act="set-toggle"]').forEach(b => {
    const on = !!s[b.dataset.key];
    b.setAttribute("aria-checked", String(on));
    b.querySelector(".switch").classList.toggle("on", on);
  });
  document.querySelectorAll('[data-act="set-accent"]').forEach(b => { const on = b.dataset.v === s.accent; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
  document.querySelectorAll('[data-act="set-glass"]').forEach(b => b.classList.toggle("on", b.dataset.v === s.glass));
  const d = daysSince(state.lastBackup);
  $("setBackup").textContent = d === null ? "Never backed up" : `Last: ${agoText(d)}`;
  $("setPersist").textContent = runningAsApp() || ui.persisted ? "Yes" : "Not guaranteed";
  $("setVersion").textContent = `${APP_VERSION} · ${APP_UPDATED}`;
  renderAiState();
  showStorage();
}

// "5 modules · 2 saved PDFs · 1.4 MB": only your own data (modules, marks, settings and saved PDFs)
async function showStorage() {
  const el = $("setStorage");
  const n = state.modules.length;
  const files = (await filesDo("readonly", store => store.getAll())) || [];
  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || ""]).size + files.reduce((sum, f) => sum + (f && f.size || 0), 0);
  const size = bytes >= 1e6 ? `${fmt(bytes / 1e6, 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  el.textContent = [`${n} module${n === 1 ? "" : "s"}`, files.length ? `${files.length} saved PDF${files.length === 1 ? "" : "s"}` : "", size].filter(Boolean).join(" · ");
}

// The Settings screen's controls (registered once the app's handler lists exist)
function registerSettingsActions() {
  ACTIONS["go-settings"] = () => go("settings");
  ACTIONS["set-pick"] = t => { setSetting(t.closest("[data-set]").dataset.set, Number(t.dataset.v)); renderSettings(); };
  CHANGES["set-goal-other"] = t => {
    const v = parseFloat(String(t.value).replace(",", "."));
    if (v >= 0 && v <= 100) setSetting("defaultGoal", v);
    renderSettings();
  };
  CHANGES["set-risk"] = t => setSetting("risk", Number(t.value));
  CHANGES["set-reminder"] = t => setSetting("reminder", t.value);
  ACTIONS["set-toggle"] = t => {
    const key = t.dataset.key;
    setSetting(key, !settings()[key]);
    renderSettings();
    if (key === "haptics" && settings().haptics) haptic();
  };
  ACTIONS["set-accent"] = t => { setSetting("accent", t.dataset.v); renderSettings(); };
  ACTIONS["set-glass"] = t => { setSetting("glass", t.dataset.v); renderSettings(); };
  ACTIONS["set-intro"] = () => { ui.ob = 0; go("onboarding"); };
  ACTIONS["set-erase"] = async () => {
    if (!confirm("Delete all your modules, marks, folders and saved PDFs from this device?\n\nThis can't be undone. Make a Backup first if you might need them.")) return;
    for (const m of state.modules) await deleteFile(m.id);
    state = { modules: [], folders: [], selectedId: null, uploadFolderId: null, settings: state.settings, onboarded: false };
    saveState();
    showToast("All modules and marks are deleted. Your settings are kept.", 5000);
    ui.ob = 0;
    go("onboarding");
  };
}

// What's on screen right now (not saved)
const ui = {
  screen: "modules", from: "modules", anim: "", ob: 0,
  addMode: "upload", pasteText: "",
  queue: [], queueTotal: 0, job: null, draft: null,
  editing: null, whatIf: false, wi: {},
};

// ---- Dates ----

const todayIso = () => {
  const t = new Date();
  return isoDate(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const daysUntil = iso => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
};
const dayMonth = iso => { const [, m, d] = iso.split("-").map(Number); return `${d} ${MON[m - 1]}`; };
const whenText = n => n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`;

// The module's next date that hasn't passed yet
function nextDate(mod) {
  return (mod.dates || [])
    .filter(d => d.date && d.label)
    .map(d => ({ ...d, days: daysUntil(d.date) }))
    .filter(d => d.days >= 0)
    .sort((a, b) => a.days - b.days)[0] || null;
}

// Every module's coming dates, soonest first
function upcomingDates() {
  const out = [];
  state.modules.forEach(m => (m.dates || []).forEach(d => {
    if (!d.date || !d.label) return;
    const n = daysUntil(d.date);
    if (n >= 0) out.push({ m, d, n });
  }));
  return out.sort((a, b) => a.n - b.n);
}

// The assessment a key date is about ("Test 1" -> the Test 1 row), if any
const assessmentFor = (mod, label) =>
  mod.assessments.find(a => norm(a.name) === norm(label)) || mod.assessments.find(a => sameName(a.name, label)) || null;
const dateFor = (mod, a) => (mod.dates || []).find(d => d.date && d.label && (norm(d.label) === norm(a.name) || sameName(d.label, a.name)));

// The countdowns follow the calendar: redraw when the day changes or the app is shown again
let shownDay = todayIso();
const redrawIfNewDay = () => {
  if (todayIso() === shownDay) return;
  shownDay = todayIso();
  if (["modules", "dates", "module"].includes(ui.screen)) render();
};
setInterval(redrawIfNewDay, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) redrawIfNewDay(); });

// ---- Module names: "PP 344 Plant Pathology" shows as code PP 344 and name Plant Pathology ----

function splitName(name) {
  const s = String(name || "").trim();
  const m = s.match(/^([A-Za-z]{2,10}\s?\d{3}[A-Za-z]?)\b[\s:·–-]*(.*)$/);
  return m && m[2] ? { code: m[1].toUpperCase(), title: m[2] } : { code: "", title: s || "Untitled module" };
}
const joinName = (code, title) => [String(code || "").trim(), String(title || "").trim()].filter(Boolean).join(" ");

// ---- Where a module stands ----

// calculate() plus what's still to come and what's needed on it (as an average on the rest,
// or in the final test once that's the only thing left). Weights that don't add up to 100%
// are scaled, like the final mark itself.
function plan(mod, goalOverride) {
  const c = calculate(mod);
  const goal = Number(goalOverride ?? mod.target) || 0;
  const scale = c.totalWeight > 0 ? 100 / c.totalWeight : 0;
  const pending = c.rows.filter(r => r.weight > 0 && !hasMark(r));
  const rem = pending.reduce((s, r) => s + r.weight, 0);
  const need = rem > 1e-6 && scale ? ((goal / scale - c.earned) / rem) * 100 : null;
  const onlyFinal = !!c.finalRow && pending.length === 1 && pending[0] === c.finalRow;
  return { ...c, goal, scale, pending, rem, remPct: rem * scale, need, onlyFinal };
}

function statusOf(mod) {
  const p = plan(mod);
  if (!p.rows.length) return { text: "No assessments yet", bad: false };
  if (p.need === null) return p.finalSoFar >= p.goal ? { text: "Passed" } : { text: "Below goal", bad: true };
  if (p.need <= 0) return { text: "Goal reached" };
  if (p.need > 100) return { text: "Goal out of reach", bad: true };
  const sub = p.onlyFinal ? Number(p.finalRow.a.subMin) || 0 : 0;
  const n = Math.ceil(Math.max(p.need, sub));
  return { text: p.onlyFinal ? `Need ${n}% in ${shortLabel(p.finalRow.a.name)}` : `Need ${n}% avg on rest`, bad: p.need > settings().risk };
}
const shortLabel = s => {
  s = String(s || "the final test").replace(/\s*\([^)]*\)\s*$/, "") || String(s);
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
};

// ---- Navigation ----

const SCREENS = {
  onboarding: "scrOnboarding", modules: "scrModules", dates: "scrDates", add: "scrAdd",
  reading: "scrReading", review: "scrReview", module: "scrModule", settings: "scrSettings", overview: "scrOverview",
};
const DEPTH = { onboarding: 0, modules: 1, dates: 1, overview: 1, add: 2, module: 2, settings: 2, reading: 3, review: 4 };

// Deeper screens slide in from the right, going back slides from the left, tabs fade
function go(screen, extra = {}) {
  const prev = ui.screen;
  const dir = prev === "review" && screen === "module" ? 1 : Math.sign((DEPTH[screen] ?? 1) - (DEPTH[prev] ?? 1));
  ui.anim = prev === screen ? "" : dir > 0 ? "push" : dir < 0 ? "pop" : "fade";
  if (prev === "reading" && screen !== "reading") clearInterval(ui.scanTimer);
  closeSheetNow();
  Object.assign(ui, { screen, editing: null }, extra);
  render();
  window.scrollTo(0, 0);
  document.body.classList.remove("scrolled");
}

function render() {
  const s = ui.screen;
  ui.entering = !!ui.anim;
  for (const [key, id] of Object.entries(SCREENS)) $(id).hidden = key !== s;
  $("tabBar").hidden = !(s === "modules" || s === "dates" || s === "overview");
  const el = $(SCREENS[s]);
  ({
    onboarding: renderOnboarding, modules: renderModules, dates: renderDates, add: renderAdd,
    reading: renderReading, review: renderReview, module: renderModulePage, settings: renderSettings, overview: renderOverview,
  })[s](el);
  renderTabs();
  if (ui.anim) {
    el.classList.remove("anim-push", "anim-pop", "anim-fade");
    void el.offsetWidth; // restart the animation
    el.classList.add("anim-" + ui.anim);
    ui.anim = "";
  }
}

function renderTabs() {
  $("tabBar").innerHTML = [["Modules", "modules"], ["Key dates", "dates"], ["Overview", "overview"]].map(([label, key]) =>
    `<button class="tab${ui.screen === key ? " on" : ""}" data-act="tab" data-to="${key}"><i></i>${label}</button>`).join("");
}

// Opens a module and closes every folder except its own
function openModule(id, from = "modules") {
  state.selectedId = id;
  const mod = currentModule();
  if (!mod) return go("modules");
  state.folders.forEach(f => (f.collapsed = f.id !== mod.folderId));
  saveState();
  go("module", { from, whatIf: false, wi: {} });
}

// Back to the list: every folder closes again, so the list stays clean
function leaveModule() {
  const to = ui.from === "dates" ? "dates" : "modules";
  state.selectedId = null;
  state.folders.forEach(f => (f.collapsed = true));
  saveState();
  go(to);
}

// ---- Clicks, typing and changes, for every screen ----

const ACTIONS = {};
document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]");
  if (t && ACTIONS[t.dataset.act]) ACTIONS[t.dataset.act](t, e);
});
const INPUTS = {};
document.addEventListener("input", e => {
  const t = e.target.closest("[data-in]");
  if (t && INPUTS[t.dataset.in]) INPUTS[t.dataset.in](t, e);
});
const CHANGES = {};
document.addEventListener("change", e => {
  const t = e.target.closest("[data-ch]");
  if (t && CHANGES[t.dataset.ch]) CHANGES[t.dataset.ch](t, e);
});

ACTIONS.tab = t => go(t.dataset.to);
ACTIONS["go-add"] = () => go("add");
ACTIONS["go-modules"] = () => go("modules");
ACTIONS["go-dates"] = () => go("dates");

// ---- 1. The intro (first time only) ----

const OB = [
  ["Upload", "Upload the module framework (study guide) for each of your modules."],
  ["Check", "The calculator finds every test and assignment with its weight. Check them and fix anything it got wrong."],
  ["Enter", "Enter your marks as you get them. Your final mark updates straight away."],
  ["Know", "Once every mark except the last test is entered, you'll see what you need in that test."],
];

// Each step shows a small, real-looking piece of the app (built from the same parts)
function obFigure(step) {
  if (step === 0) {
    const lines = [
      ["MODULE FRAMEWORK – BIO 112", "Module"], ["Assessment plan", ""], ["Class Test 1          15%", "15%"],
      ["Assignment 1          10%", "10%"], ["Class Test 2          15%", "15%"], ["Practical Report      10%", "10%"],
      ["A2 (Final test)       50%", "50%"], ["Sub-minimum of 40% in A2", "Rule"],
    ];
    return `<div class="ob-art"><div class="eyebrow">Reading framework</div><div class="ob-lines">${lines.map(([t, tag]) =>
      `<div class="ln seen${tag ? " hit" : ""}"><span>${t}</span><b>${tag}</b></div>`).join("")}</div></div>`;
  }
  if (step === 1) {
    const ws = [["Class Test 1", 15, 0], ["Assignment 1", 10, 0], ["Class Test 2", 15, 0], ["Practical Report", 10, 0], ["A2 (Final test)", 50, 1]];
    return `<div class="ob-art gap8">
      <div class="segs">${ws.map(([, p, f]) => `<i style="flex:${p};background:var(--color-accent-${f ? 700 : 400})"></i>`).join("")}</div>
      <div class="row-between fs13"><span class="acc7">Weights add up to 100%</span><b class="cond16 acc7">100%</b></div>
      ${ws.map(([n, p, f]) => `<div class="ob-rv"><span>${n}</span><span class="num-box"><b>${p}</b><span>%</span></span><span class="dot${f ? " on" : ""}"><i></i></span></div>`).join("")}
    </div>`;
  }
  if (step === 2) {
    return `<div class="ob-art gap12"><ul class="mod-list">${exampleRowHtml()}</ul>
      <div class="ob-sheet"><div class="meta12">Class Test 2 · 15% of the final mark</div><div class="ob-mark">34/50</div><div class="meta12">= 68%</div></div></div>`;
  }
  return `<div class="goal-panel ob-goal">
      <div class="eyebrow on-dark">Final mark I want · 50%</div>
      <div class="need-row"><div class="hero64">47%</div><div class="fs14 lh135">needed in A2 to finish on 50%</div></div>
      <div class="sub-note">A2 has a 40% sub-minimum, so you need at least that there.</div>
    </div>`;
}

function renderOnboarding(el) {
  const ob = ui.ob;
  el.innerHTML = `
    <div class="ob">
      <div class="row-between"><div class="brand">Mark Calculator</div><button class="link-acc pad10" data-act="ob-skip">Skip</button></div>
      <div class="blueprint ob-fig"><div class="ob-anim" key="${ob}">${obFigure(ob)}</div></div>
      <div class="ob-text ob-anim">
        <div class="ob-num">0${ob + 1} / 04</div>
        <h1 class="ob-title">${OB[ob][0]}</h1>
        <p class="ob-body">${OB[ob][1]}</p>
      </div>
      <div class="ob-dots">${OB.map((_, i) => `<i class="${i <= ob ? "on" : ""}"></i>`).join("")}</div>
      <button class="blueprint btn-solid h54" data-act="ob-next">${ob === 3 ? "Add your first module" : "Next"}</button>
      ${ob === 3 ? `<button class="link-acc center" data-act="try-example">Try with an example module first</button>` : ""}
    </div>`;
}
ACTIONS["ob-next"] = () => {
  if (ui.ob < 3) { ui.ob++; render(); return; }
  state.onboarded = true;
  saveState();
  go("add");
};
ACTIONS["ob-skip"] = () => { state.onboarded = true; saveState(); go("modules"); };

// ---- 2. My modules ----

// Module colours: seven hues checked for colour-blind separation in light and dark mode.
// Red isn't one of them: it's kept for "at risk". The module's name is always shown next to it.
const MODULE_COLOURS = ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet"];
// Each module without a colour gets the first one not used yet (in this fixed order)
function ensureColours() {
  for (const m of state.modules) {
    if (MODULE_COLOURS.includes(m.color)) continue;
    const used = new Set(state.modules.map(x => x.color));
    m.color = MODULE_COLOURS.find(c => !used.has(c)) || MODULE_COLOURS[state.modules.indexOf(m) % MODULE_COLOURS.length];
  }
}
const swatch = m => `<i class="mc mc-${MODULE_COLOURS.includes(m.color) ? m.color : "blue"}" aria-hidden="true"></i>`;

// Has the module reached (banked) its goal?
const goalMet = p => p.rows.length > 0 && (p.need === null ? p.finalSoFar >= p.goal : p.need <= 0);

// "in 2 days" as a short tag: "today", "tomorrow", "2 days"
const shortWhen = n => (n === 0 ? "today" : n === 1 ? "tomorrow" : `${n} days`);

// The next test or due date, big, with what it counts and what you need in it
function nextUpHtml() {
  const nd = upcomingDates()[0];
  if (!nd) {
    return `
      <div class="blueprint next-up">
        <div class="eyebrow">Next up</div>
        <div class="nu-what">Nothing coming up</div>
        <div class="meta13">Dates of tests and due dates show here. Add them on a module's page if the framework had none.</div>
      </div>`;
  }
  const m = nd.m, p = plan(m), a = assessmentFor(m, nd.d.label);
  const { code, title } = splitName(m.name);
  let need = statusOf(m).text, bad = statusOf(m).bad;
  if (a && !String(a.mark ?? "").trim()) {
    if (p.need === null) need = "";
    else if (p.need <= 0) { need = "Your goal is already banked"; bad = false; }
    else if (p.need > 100) { need = "Your goal is out of reach"; bad = true; }
    else if (p.onlyFinal && p.finalRow.a === a) { need = `You need ${Math.ceil(Math.max(p.need, Number(a.subMin) || 0))}%`; bad = p.need > settings().risk; }
    else { need = `You need ${Math.ceil(p.need)}% on average`; bad = p.need > settings().risk; }
  }
  const counts = a ? `Counts ${fmt(effectiveWeight(m, a), 1)}%` : "";
  return `
    <button class="blueprint next-up press" data-act="open-module" data-id="${m.id}">
      <span class="row-between"><span class="eyebrow">Next up</span><span class="nu-when${nd.n <= 7 ? " soon" : ""}">${whenText(nd.n)}</span></span>
      <span class="nu-what">${esc(nd.d.label)}</span>
      <span class="nu-mod">${swatch(m)}${esc(code ? `${code} · ${title}` : title)} · ${dayMonth(nd.d.date)}${dateExtra(nd.d) ? " · " + esc(dateExtra(nd.d)) : ""}</span>
      ${counts || need ? `<span class="nu-need">${counts ? `<span>${counts}</span>` : ""}${need ? `<b class="${bad ? "bad-text" : "acc7"}">${esc(need)}</b>` : ""}</span>` : ""}
    </button>`;
}

function renderModules(el) {
  const mods = state.modules;
  const avg = averageOf(mods);
  const avgNote = avg.missing && avg.someCredits
    ? `Add credits to ${avg.missing} more module${avg.missing === 1 ? "" : "s"} (pencil on its page) to weight the average by credits.` : "";
  const onTrack = mods.filter(m => { const p = plan(m); return p.need === null ? p.finalSoFar >= p.goal : p.need <= settings().risk; }).length;
  const loose = mods.filter(m => !m.folderId);
  const entering = ui.entering;

  el.innerHTML = `
    <div class="screen-head">
      <h1 class="h-screen">My modules</h1>
      <div class="head-actions">
        <button class="sq-btn line" data-act="go-settings" aria-label="Settings" title="Settings">${ic("gear", 22)}</button>
        <button class="sq-btn solid" data-act="go-add" aria-label="Add a module">${ic("plus", 22)}</button>
      </div>
    </div>
    ${mods.length ? `
    ${nextUpHtml()}
    <div class="summary-row">
      <span><b data-count="${avg.value ?? ""}">${avg.value == null ? "–" : r1(avg.value) + "%"}</b> ${avg.weighted ? `average · by ${fmt(avg.credits)} credits` : "average on work done"}</span>
      <span><b>${onTrack} of ${mods.length}</b> on track</span>
    </div>
    ${avgNote ? `<div class="meta12 summary-note">${avgNote}</div>` : ""}
    ${backupNudgeHtml()}` : `
    <div class="blueprint empty">
      <div class="eyebrow">No modules yet</div>
      <p>Upload a module framework and the calculator finds every test and assignment with its weight. Your modules will look like this:</p>
      <ul class="mod-list ghost" aria-hidden="true">${exampleRowHtml()}</ul>
      <button class="blueprint btn-solid" data-act="go-add">Add your first module</button>
      <button class="btn-line h48" data-act="try-example">Try with an example module</button>
    </div>`}
    <ul id="moduleList" class="mod-list">
      ${state.folders.map(folderHtml).join("")}
      ${loose.length && state.folders.length ? `<li class="list-label">Not in a folder</li>` : ""}
      ${loose.map(moduleRowHtml).join("")}
    </ul>
    <div class="list-foot">
      <button class="link-acc" data-act="new-folder">${ic("folderPlus", 16)}New folder</button>
      ${mods.length > 1 || state.folders.length > 1 ? `<span class="meta12">Drag ${ic("grip", 14)} to reorder</span>` : ""}
    </div>`;

  el.querySelectorAll(".folder").forEach(li => {
    makeSortable(li.querySelector(".folder-head .sort-handle"), li, {
      siblings: () => [...$("moduleList").children].filter(c => c.classList.contains("folder")),
      onReorder: (from, to) => { state.folders.splice(to, 0, state.folders.splice(from, 1)[0]); saveState(); render(); },
    });
  });
  el.querySelectorAll("#moduleList .mod-item").forEach(li => {
    makeSortable(li.querySelector(".sort-handle"), li, {
      siblings: () => [...li.parentElement.children].filter(c => c.classList.contains("mod-item")),
      onReorder: (from, to) => {
        const ids = [...li.parentElement.children].filter(c => c.classList.contains("mod-item")).map(c => c.dataset.mid);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        reorderModules(ids);
      },
      onDropFolder: fid => moveModule(li.dataset.mid, fid),
    });
  });
  if (entering) introduce(el);
}

// A folder's heading: name, how many modules, its average, and a thin bar of that average
// against the folder's goals along the bottom edge
function folderHtml(f) {
  const mods = state.modules.filter(m => m.folderId === f.id);
  const open = !f.collapsed;
  const a = averageOf(mods);
  const goal = mods.length ? mods.reduce((s, m) => s + (Number(m.target) || 0), 0) / mods.length : 50;
  return `
    <li class="folder${open ? "" : " collapsed"}" data-fid="${f.id}">
      <div class="folder-head" role="button" tabindex="0" aria-expanded="${open}" data-act="folder-toggle">
        <span class="folder-chevron">${ic("chevR", 16)}</span>
        <span class="folder-name">${esc(f.name || "Unnamed folder")}</span>
        <span class="folder-tools">
          <button class="tool" data-act="folder-rename" aria-label="Rename folder">${ic("pencil", 16)}</button>
          <button class="tool del" data-act="folder-delete" aria-label="Delete folder">${ic("trash", 16)}</button>
        </span>
        <span class="folder-count"><span class="fc-n">${mods.length} module${mods.length === 1 ? "" : "s"}</span>${a.value == null ? "" :
          `<span class="fc-n"> · </span><b title="${a.weighted ? "Average on work done, weighted by credits" : "Average on work done"}">${r1(a.value)}%</b>`}</span>
        <span class="sort-handle" aria-label="Drag to reorder">${ic("grip", 16)}</span>
        ${a.value == null ? "" : `<span class="f-bar" aria-hidden="true"><i class="${a.value >= goal ? "done" : ""}" style="transform:scaleX(${clamp(a.value, 0, 100) / 100})"></i><b style="left:${clamp(goal, 0, 100)}%"></b></span>`}
      </div>
      <div class="folder-body"><div><ul class="mod-list inner">
        ${mods.length ? mods.map(moduleRowHtml).join("") : `<li class="folder-empty">No modules yet. Drag one onto this folder, or pick it under <b>Save to folder</b> when you add a module.</li>`}
      </ul></div></div>
    </li>`;
}

// Colour, code, name, final mark so far, a bar with the goal marked, where it stands, and the
// next date as a small tag. Modules at risk get a red edge and a warning sign.
function moduleRowHtml(m) {
  const p = plan(m);
  const st = statusOf(m);
  const { code, title } = splitName(m.name);
  const nx = nextDate(m);
  const reached = goalMet(p) && p.finalSoFar > 0;
  const good = !st.bad && (st.text === "Goal reached" || st.text === "Passed");
  const tagLabel = nx ? (nx.label.length > 14 ? nx.label.slice(0, 13) + "…" : nx.label) : "";
  return `
    <li class="mod-item${st.bad ? " risk" : ""}" data-mid="${m.id}">
      <button class="mod-row" data-act="open-module" data-id="${m.id}">
        <span class="m-top">
          <span class="m-names"><span class="m-code">${swatch(m)}${esc(code)}</span><span class="m-name">${esc(title)}</span></span>
          <span class="m-final" data-count="${p.finalSoFar}">${r1(p.finalSoFar)}%</span>
        </span>
        <span class="bar6"><i class="${reached ? "done" : ""}" style="transform:scaleX(${clamp(p.finalSoFar, 0, 100) / 100})"></i><b style="left:${clamp(p.goal, 0, 100)}%"></b></span>
        <span class="m-foot">
          <span class="m-status${st.bad ? " bad" : good ? " good" : ""}">${st.bad ? ic("alert", 14) : good ? ic("check", 14) : ""}<span>${esc(st.text)}</span></span>
          ${nx ? `<span class="date-tag${nx.days <= 7 ? " soon" : ""}">${esc(tagLabel)} · ${shortWhen(nx.days)}</span>` : ""}
        </span>
      </button>
      <span class="sort-handle" aria-label="Drag to reorder">${ic("grip", 16)}</span>
    </li>`;
}

// What a module looks like, for the empty list and the intro
function exampleRowHtml() {
  return `
    <li class="mod-item example">
      <span class="mod-row">
        <span class="m-top">
          <span class="m-names"><span class="m-code"><i class="mc mc-blue"></i>BIO 112</span><span class="m-name">Cell Biology</span></span>
          <span class="m-final">34.8%</span>
        </span>
        <span class="bar6"><i style="transform:scaleX(0.348)"></i><b style="left:50%"></b></span>
        <span class="m-foot"><span class="m-status"><span>Need 47% in A2</span></span><span class="date-tag soon">A2 · 3 days</span></span>
      </span>
    </li>`;
}

ACTIONS["open-module"] = t => openModule(t.dataset.id, "modules");
ACTIONS["folder-toggle"] = (t, e) => {
  if (e.target.closest(".folder-tools, .sort-handle, .folder-rename")) return;
  const f = state.folders.find(x => x.id === t.closest(".folder").dataset.fid);
  f.collapsed = !f.collapsed;
  const li = t.closest(".folder");
  li.classList.toggle("collapsed", f.collapsed);
  t.setAttribute("aria-expanded", String(!f.collapsed));
  saveState();
};
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("folder-head")) { e.preventDefault(); e.target.click(); }
});
ACTIONS["folder-rename"] = t => {
  const li = t.closest(".folder");
  startRenameFolder(li, state.folders.find(x => x.id === li.dataset.fid));
};
ACTIONS["folder-delete"] = t => {
  const f = state.folders.find(x => x.id === t.closest(".folder").dataset.fid);
  const i = state.folders.indexOf(f);
  const mods = state.modules.filter(m => m.folderId === f.id);
  const wasUpload = state.uploadFolderId === f.id;
  mods.forEach(m => (m.folderId = null));
  state.folders.splice(i, 1);
  if (wasUpload) state.uploadFolderId = null;
  saveState();
  render();
  undoable(mods.length ? `Deleted the folder ${f.name}. Its modules are kept.` : `Deleted the folder ${f.name}.`, () => {
    state.folders.splice(Math.min(i, state.folders.length), 0, f);
    mods.forEach(m => (m.folderId = f.id));
    if (wasUpload) state.uploadFolderId = f.id;
    saveState();
    render();
  });
};
ACTIONS["new-folder"] = () => {
  const f = { id: uid(), name: `Semester ${state.folders.length + 1}`, collapsed: false };
  state.folders.push(f);
  saveState();
  render();
  const li = document.querySelector(`.folder[data-fid="${f.id}"]`);
  if (li) startRenameFolder(li, f);
};

// Swaps the folder's name for a text box; Enter or tapping elsewhere saves it
function startRenameFolder(li, f) {
  const nameEl = li.querySelector(".folder-name");
  const input = document.createElement("input");
  input.className = "folder-rename";
  input.value = f.name;
  input.setAttribute("aria-label", "Folder name");
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const save = () => {
    if (done) return;
    done = true;
    f.name = input.value.trim() || f.name || "Unnamed folder";
    saveState();
    render();
  };
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") input.value = f.name;
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); save(); }
  });
  input.addEventListener("blur", save);
}

// Puts the given modules (all in one folder, or all outside folders) in this order
function reorderModules(ids) {
  const byId = Object.fromEntries(state.modules.map(m => [m.id, m]));
  const slots = state.modules.map((m, i) => (ids.includes(m.id) ? i : -1)).filter(i => i >= 0);
  slots.forEach((slot, k) => (state.modules[slot] = byId[ids[k]]));
  saveState();
  render();
}

function moveModule(moduleId, folderId) {
  const mod = state.modules.find(m => m.id === moduleId);
  if (!mod || mod.folderId === folderId) return;
  mod.folderId = folderId;
  saveState();
  render();
}

// Drag to reorder, by the grip. Uses pointer events, so it works with a mouse and a finger.
// onDropFolder: dropping on another folder's heading moves the item into that folder.
function makeSortable(handle, item, { siblings, onReorder, onDropFolder }) {
  if (!handle) return;
  handle.addEventListener("click", e => e.stopPropagation());
  handle.addEventListener("pointerdown", e => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const items = siblings();
    const from = items.indexOf(item);
    if (from < 0) return;
    const rects = items.map(el => { const r = el.getBoundingClientRect(); return { top: r.top + window.scrollY, height: r.height }; });
    const gap = items.length > 1 ? Math.max(0, rects[1].top - (rects[0].top + rects[0].height)) : 0;
    const startY = e.clientY + window.scrollY;
    let to = from, folderTarget = null, moved = false;

    item.classList.add("dragging");
    document.body.classList.add("is-dragging");
    items.forEach(el => el !== item && el.classList.add("drag-shift"));
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    const clearTargets = () => document.querySelectorAll(".folder.drop-target").forEach(el => el.classList.remove("drop-target"));
    const move = ev => {
      const dy = ev.clientY + window.scrollY - startY;
      if (Math.abs(dy) > 4) moved = true;
      item.style.transform = `translateY(${dy}px)`;
      const middle = rects[from].top + rects[from].height / 2 + dy;
      to = rects.filter((r, i) => i !== from && r.top + r.height / 2 < middle).length;
      const step = rects[from].height + gap;
      items.forEach((el, i) => {
        if (i === from) return;
        const shift = i > from && i <= to ? -step : i < from && i >= to ? step : 0;
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
      if (onDropFolder) {
        const head = document.elementsFromPoint(ev.clientX, ev.clientY)
          .map(el => el.closest && el.closest(".folder-head"))
          .find(h => h && !item.contains(h) && !h.closest(".folder").contains(item));
        clearTargets();
        folderTarget = head ? head.closest(".folder").dataset.fid : null;
        if (head) head.closest(".folder").classList.add("drop-target");
      }
      // Keep scrolling while dragging near the top or bottom of the screen
      if (ev.clientY < 80) window.scrollBy(0, -10);
      else if (ev.clientY > window.innerHeight - 100) window.scrollBy(0, 10);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-dragging");
      item.classList.remove("dragging");
      item.style.transform = "";
      items.forEach(el => { el.style.transform = ""; el.classList.remove("drag-shift"); });
      clearTargets();
      if (folderTarget) onDropFolder(folderTarget);
      else if (moved && to !== from) onReorder(from, to);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

// ---- 3. Key dates (every module's coming dates) ----

function renderDates(el) {
  const items = upcomingDates();
  const today = new Date().toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
  const groups = [["This week", x => x.n <= 7], ["Later", x => x.n > 7]]
    .map(([label, fn]) => ({ label, items: items.filter(fn) })).filter(g => g.items.length);
  el.innerHTML = `
    <div class="title-block">
      <h1 class="h-screen">Key dates</h1>
      <div class="meta14">Read from your frameworks. Today is ${esc(today)}.</div>
    </div>
    ${items.length ? `<button class="btn-line h48" data-act="cal-all">${ic("calPlus", 18)}Add all to my calendar</button>` : ""}
    ${groups.length ? groups.map(g => `
      <div class="date-group">
        <div class="eyebrow group-label">${g.label}</div>
        ${g.items.map(x => {
          const a = assessmentFor(x.m, x.d.label);
          const { code, title } = splitName(x.m.name);
          const soon = x.n <= 7;
          const weight = a ? ` · ${fmt(effectiveWeight(x.m, a), 1)}% of final${a.isFinal ? " · final test" : ""}` : "";
          return `
          <button class="date-row press" data-act="open-module-dates" data-id="${x.m.id}">
            <span class="date-box${soon ? " soon" : ""}"><b>${Number(x.d.date.slice(8))}</b><span>${MON[Number(x.d.date.slice(5, 7)) - 1]}</span></span>
            <span class="date-what"><span class="date-name">${esc(x.d.label)}</span><span class="meta13">${swatch(x.m)}${esc(code || title)}${weight}</span>${dateExtra(x.d) ? `<span class="meta13 date-extra">${esc(dateExtra(x.d))}</span>` : ""}</span>
            <span class="date-when${soon ? " soon" : ""}">${whenText(x.n)}</span>
          </button>`;
        }).join("")}
      </div>`).join("") : `
      <div class="blueprint empty">
        <div class="eyebrow">Nothing coming up</div>
        <p>Dates of tests, exams and due dates are read from each framework. You can add or fix them on a module's page.</p>
      </div>`}`;
}
ACTIONS["open-module-dates"] = t => openModule(t.dataset.id, "dates");

// ---- 4. Add a module ----

const SAMPLE_SIMPLE = `MODULE FRAMEWORK - BIO 112: Introduction to Cell Biology
Semester 2

Assessment Plan

Assessment            Weight
Class Test 1          15%
Assignment 1          10%
Class Test 2          15%
Practical Report      10%
A2 (Final test)       50%

Rules
Students need a sub-minimum of 40% in A2 to pass the module.
A final mark of at least 50% is required to pass.
Late submissions will receive a penalty of 10% per day.`;

const SAMPLE_GROUPS = `MODULE FRAMEWORK - CHE 132: General Chemistry
Semester 2, 2026

Class mark
Test 1 (14 Aug)          40%
Test 2 (25 Sep)          40%
Tutorials                20%
Total                    100%

Final module mark = 40% class mark + 60% theory exam mark

Theory exam mark (A2 assessment) on 12 Nov.

Rules
A sub-minimum of 40% for the theory exam is required.
A final mark of at least 50% is required to pass.`;

function folderOptions(value) {
  return `<option value="">No folder</option>` +
    state.folders.map(f => `<option value="${f.id}"${f.id === value ? " selected" : ""}>${esc(f.name || "Unnamed folder")}</option>`).join("");
}

function renderAdd(el) {
  const upload = ui.addMode === "upload";
  const ai = aiOn();
  el.innerHTML = `
    <div class="top-row"><button class="back" data-act="go-modules">${ic("chevL")}My modules</button></div>
    <h1 class="h-screen h34">Add a module from its framework</h1>
    <div class="seg2">
      <button class="${upload ? "on" : ""}" data-act="add-mode" data-mode="upload">Upload</button>
      <button class="${upload ? "" : "on"}" data-act="add-mode" data-mode="paste">Paste text</button>
    </div>
    ${upload ? `
      <div id="dropPanel" class="blueprint drop">
        <span class="acc7">${ic("upload", 36)}</span>
        <div class="h22">Upload module framework</div>
        <div class="meta14 narrow">PDF, Word (.docx), text file${ai ? " or a photo of the page" : ""}. You can choose several at once.</div>
        <div class="stack10">
          <button class="blueprint btn-solid" data-act="choose-files">Choose files</button>
          <button class="btn-line" data-act="take-photo">${ic("camera", 18)}Take a photo</button>
        </div>
      </div>
      ${state.folders.length ? `
      <label class="field-row"><span class="meta14">Save to folder</span>
        <select class="plain-select" data-ch="upload-folder">${folderOptions(state.uploadFolderId)}</select></label>` : ""}
      <div class="meta13">${ai
        ? "The AI reader is on: frameworks are sent to Google's Gemini AI to be read. Photos need the AI reader."
        : "Files are read on this phone. Nothing is uploaded unless the AI reader is on (Settings)."}</div>
      <button class="link-acc" data-act="add-manual">${ic("hand", 16)}Add a module by hand instead</button>` : `
      <div class="paste-head">
        <span class="meta13">Paste the assessment table and rules</span>
        <span class="row-gap12"><button class="link-acc sm" data-act="sample" data-which="simple">Simple sample</button><button class="link-acc sm" data-act="sample" data-which="groups">Sample with groups</button></span>
      </div>
      <textarea id="pasteBox" class="paste" spellcheck="false" data-in="paste" placeholder="Copy the assessment section of your framework and paste it here">${esc(ui.pasteText)}</textarea>
      <button class="blueprint btn-solid" data-act="read-paste">Read framework</button>`}`;

  const panel = $("dropPanel");
  if (panel) {
    ["dragenter", "dragover"].forEach(ev => panel.addEventListener(ev, e => { e.preventDefault(); panel.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach(ev => panel.addEventListener(ev, e => { e.preventDefault(); panel.classList.remove("dragover"); }));
    panel.addEventListener("drop", e => startJobs([...e.dataTransfer.files].map(file => ({ file }))));
  }
}
ACTIONS["add-mode"] = t => { ui.addMode = t.dataset.mode; render(); };
ACTIONS["choose-files"] = () => $("fileInput").click();
ACTIONS["take-photo"] = () => {
  if (!aiOn()) { showToast("Reading a photo needs the AI reader. Turn it on in Settings (the gear on My modules)."); return; }
  $("photoInput").click();
};
ACTIONS.sample = t => { ui.pasteText = t.dataset.which === "groups" ? SAMPLE_GROUPS : SAMPLE_SIMPLE; render(); };
INPUTS.paste = t => (ui.pasteText = t.value);
ACTIONS["read-paste"] = () => {
  if (!ui.pasteText.trim()) { showToast("Paste the framework's assessment section first."); return; }
  startJobs([{ text: ui.pasteText, src: "Pasted text" }]);
};
CHANGES["upload-folder"] = t => { state.uploadFolderId = t.value || null; saveState(); };
ACTIONS["add-manual"] = () => {
  ui.queue = [];
  ui.job = null;
  ui.draft = {
    mode: "new",
    mod: {
      id: uid(), name: "", fileName: "", target: settings().defaultGoal, folderId: state.uploadFolderId || null, groups: [], notes: [], rules: [], dates: [],
      assessments: [
        { id: uid(), name: "Test 1", weight: 25, mark: "", isFinal: false, groupId: null },
        { id: uid(), name: "Assignment 1", weight: 25, mark: "", isFinal: false, groupId: null },
        { id: uid(), name: "A2 (final test)", weight: 50, mark: "", isFinal: true, groupId: null },
      ],
    },
  };
  go("review");
};

$("fileInput").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) startJobs(files.map(file => ({ file })));
});
$("photoInput").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) startJobs(files.map(file => ({ file })));
});

// ---- 5. Reading the framework ----
// Each file (or the pasted text) is read with the same readers as before: the built-in reader,
// or the AI reader when it's on. The text is then shown line by line, with the lines the
// reader used marked, before the weights are checked.

function startJobs(items) {
  ui.queue = items.slice();
  ui.queueTotal = items.length;
  nextJob();
}

async function nextJob() {
  const item = ui.queue.shift();
  if (!item) return;
  const src = item.file ? item.file.name : item.src;
  const job = ui.job = {
    src, index: ui.queueTotal - ui.queue.length, total: ui.queueTotal,
    status: "Opening the file…", lines: null, hits: [], draft: null, pdf: null, scan: 0, done: false,
  };
  go("reading");
  const setStatus = msg => { job.status = msg; if (ui.job === job && ui.screen === "reading") paintReadingStatus(); };
  try {
    const photo = item.file && /^image\//.test(item.file.type) ? item.file : null;
    let text = "";
    if (item.file && !photo) text = await extractText(item.file);
    else if (!item.file) text = item.text;
    const pdf = item.file && /\.pdf$/i.test(item.file.name) ? item.file : null;

    let parsed = null, readBy = "built-in";
    const notes = [];
    if (aiOn() || photo) {
      setStatus("The AI is reading the framework… (this can take up to a minute)");
      try {
        const result = photo ? await aiReadPhoto(photo, setStatus) : await aiRead(text, setStatus, pdf);
        ({ parsed, readBy } = chooseReading(result, text));
      } catch (err) {
        if (photo) throw err;
        console.warn(err);
        notes.push(`The AI couldn't read this framework (${err.message.replace(/\.$/, "")}), so the built-in reader was used.`);
      }
    }
    if (!parsed) parsed = parseFramework(text);
    if (ui.job !== job) return; // the student went somewhere else meanwhile

    const mod = {
      id: uid(),
      name: parsed.name || guessModuleName(text, item.file ? item.file.name : "Pasted text"),
      fileName: item.file ? item.file.name : "",
      pasted: !item.file || undefined,
      readBy,
      aiInput: readBy === "ai" ? parsed.input : undefined,
      target: settings().defaultGoal,
      folderId: state.uploadFolderId || null,
      groups: parsed.groups,
      assessments: parsed.assessments,
      notes: [...(parsed.notes || []), ...notes],
      rules: parsed.rules || [],
      dates: parsed.dates || [],
      sourceText: text.slice(0, SOURCE_TEXT_LIMIT), // kept so the AI can read it again later
    };
    findSubMinimums(mod);
    findAdmission(mod);
    job.pdf = pdf;
    job.draft = { mode: "new", mod };
    job.lines = photo ? photoLines(mod) : textLines(text);
    job.hits = lineTags(job.lines, mod);
    job.status = "";
    if (ui.screen === "reading") { renderReading($("scrReading")); startScan(); }
  } catch (err) {
    console.error(err);
    job.error = `Could not read ${src}: ${err.message}`;
    if (ui.screen === "reading") renderReading($("scrReading"));
  }
}

// A photo of a framework page, read by the AI (the built-in reader can't read photos)
async function aiReadPhoto(file, onStatus) {
  const data = await blobToBase64(file);
  const result = await aiReadParts([
    { inlineData: { mimeType: file.type || "image/jpeg", data } },
    { text: "This photo shows (part of) the module framework. Read everything on it, including tables and footnotes." },
  ], onStatus);
  result.input = "photo";
  return result;
}

// Sub-minimums written in the rules ("a sub-minimum of 40% in A2") go on that assessment
function findSubMinimums(mod) {
  for (const rule of mod.rules || []) {
    const m = rule.match(/sub-?minimum\s+(?:of\s+)?(\d{1,3}(?:[.,]\d+)?)\s*%/i) || rule.match(/(\d{1,3})\s*%\s+sub-?minimum/i);
    if (!m) continue;
    const pct = parseFloat(m[1].replace(",", "."));
    const r = norm(rule);
    const named = mod.assessments.find(a => { const n = norm(a.name); return n.length >= 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(r); });
    const target = named || (/\b(exam|eksamen|a2|final test|theory exam)\b/i.test(rule) ? mod.assessments.find(a => a.isFinal) : null);
    if (target && !target.subMin && pct > 0 && pct <= 100) target.subMin = pct;
  }
}

function textLines(text) {
  return text.split(/\r?\n/)
    .map(l => l.split(PARA_END).join("").split("¦").map(s => s.trim()).filter(Boolean).join("   ").replace(/[ \t]+$/, ""))
    .filter(l => l.trim())
    .slice(0, 1500);
}
function photoLines(mod) {
  return ["Photo read by the AI", ...mod.assessments.map(a => `${a.name}   ${fmt(Number(a.weight) || 0, 2)}%`), ...(mod.rules || [])];
}

// Which lines the reader used, and for what: "15%", "Group", "Formula", "Rule", "Module"
function lineTags(lines, mod) {
  const names = mod.assessments.map(a => ({ n: norm(a.name), a })).filter(x => x.n.length >= 2);
  const groupNames = mod.groups.map(g => norm(g.name)).filter(Boolean);
  const rules = (mod.rules || []).map(r => norm(r));
  const { code } = splitName(mod.name);
  let moduleTagged = false;
  return lines.map(line => {
    const n = norm(line);
    if (!n) return "";
    if (!moduleTagged && ((code && n.includes(norm(code))) || /framework|raamwerk/i.test(line))) { moduleTagged = true; return "Module"; }
    if (/=/.test(line) && /\d\s*%/.test(line)) return "Formula";
    const pct = line.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
    if (pct) {
      const hit = names.find(x => n.includes(x.n)) || names.find(x => sameName(x.a.name, line.replace(/\d.*$/, "")));
      if (hit) return `${fmt(Number(hit.a.weight) || 0, 2)}%`;
    }
    if (groupNames.some(g => n === g || (n.startsWith(g) && n.length < g.length + 12))) return "Group";
    if (n.length >= 14 && rules.some(r => r.includes(n) || (n.length > 30 && n.includes(r.slice(0, 30))))) return "Rule";
    return "";
  });
}

function renderReading(el) {
  const job = ui.job;
  if (!job) return go("add");
  const count = job.total > 1 ? `File ${job.index} of ${job.total} · ` : "";
  if (job.error || !job.lines) {
    el.innerHTML = `
      <div class="title-block pt12"><div class="eyebrow">${esc(count + job.src)}</div>
        <h1 class="h-screen h32">${job.error ? "Couldn't read it" : "Reading framework…"}</h1></div>
      <div class="blueprint read-wait">
        <div id="readStatus" class="${job.error ? "bad-text" : "pulse"}">${esc(job.error || job.status)}</div>
      </div>
      ${job.error ? `<button class="blueprint btn-solid" data-act="${ui.queue.length ? "next-file" : "go-add"}">${ui.queue.length ? "Next file" : "Back"}</button>` : ""}`;
    return;
  }
  el.innerHTML = `
    <div class="title-block pt12"><div class="eyebrow">${esc(count + job.src)}</div>
      <h1 id="readTitle" class="h-screen h32">${job.done ? "Framework read" : "Reading framework…"}</h1></div>
    <div class="blueprint read-lines" id="readLines">
      ${job.lines.map((t, i) => `<div class="ln${i < job.scan ? " seen" : ""}${i < job.scan && job.hits[i] ? " hit" : ""}"><span>${esc(t)}</span><b>${i < job.scan ? esc(job.hits[i]) : ""}</b></div>`).join("")}
    </div>
    <div class="row-between fs14 sticky-sum">
      <span id="readCount"></span>
      <span id="readTotal" class="cond15"></span>
    </div>
    <div id="readDone" ${job.done ? "" : "hidden"}><button class="blueprint btn-solid" data-act="go-review">Check the weights</button></div>
    ${job.done ? "" : `<button id="readSkip" class="link-acc center" data-act="read-all">Show all</button>`}`;
  paintReadCount();
}
function paintReadingStatus() {
  const s = $("readStatus");
  if (s) s.textContent = ui.job.status;
}
function paintReadCount() {
  const job = ui.job;
  const mod = job.draft.mod;
  const c = calculate(mod);
  const found = job.hits.slice(0, job.scan).filter(t => /%$/.test(t)).length;
  $("readCount").textContent = job.done
    ? `${mod.assessments.length} assessment${mod.assessments.length === 1 ? "" : "s"}${mod.groups.length ? ` · ${mod.groups.length} group${mod.groups.length > 1 ? "s" : ""}` : ""} found`
    : `${Math.min(found, mod.assessments.length)} found so far`;
  $("readTotal").textContent = job.done ? `${fmt(c.totalWeight, 2)}% of final mark` : "";
}
// Lines appear one after another (faster for long frameworks: it never takes more than a few seconds)
function startScan() {
  const job = ui.job;
  clearInterval(ui.scanTimer);
  const rows = [...document.querySelectorAll("#readLines .ln")];
  const step = reduceMotion() ? 1e9 : clamp(2600 / rows.length, 10, 150);
  if (step >= 1e9) return finishScan();
  ui.scanTimer = setInterval(() => {
    if (ui.job !== job || ui.screen !== "reading") return clearInterval(ui.scanTimer);
    const i = job.scan++;
    const row = rows[i];
    if (row) {
      row.classList.add("seen");
      if (job.hits[i]) { row.classList.add("hit"); row.querySelector("b").textContent = job.hits[i]; }
    }
    paintReadCount();
    if (job.scan >= rows.length) finishScan();
  }, step);
}
function finishScan() {
  const job = ui.job;
  clearInterval(ui.scanTimer);
  job.scan = job.lines.length;
  job.done = true;
  if (ui.screen === "reading") renderReading($("scrReading"));
}
ACTIONS["read-all"] = finishScan;
ACTIONS["next-file"] = () => nextJob();
ACTIONS["go-review"] = () => {
  ui.splitFor = null; ui.draft = ui.job.draft; go("review"); };

// ---- 6. Check the weights (new modules, and "Edit" on a module) ----

function reviewCheck(mod) {
  const c = calculate(mod);
  const total = Math.round(c.totalWeight * 100) / 100;
  const used = mod.groups.filter(g => mod.assessments.some(a => a.groupId === g.id));
  const badGroup = used.find(g => Math.abs(c.groupStats[g.id].inner - 100) > 0.5);
  const ok = mod.assessments.length > 0 && Math.abs(total - 100) < 0.5 && !badGroup;
  return { c, total, badGroup, ok };
}

function renderReview(el) {
  const d = ui.draft;
  if (!d) return go("modules");
  const mod = d.mod;
  // New modules get a free colour to start with
  if (!MODULE_COLOURS.includes(mod.color)) {
    const used = new Set(state.modules.map(x => x.color));
    mod.color = MODULE_COLOURS.find(c => !used.has(c)) || MODULE_COLOURS[state.modules.length % MODULE_COLOURS.length];
  }
  // A name that is only a code ("CHE 132") goes in the Code box
  const onlyCode = /^[A-Za-z]{2,10}\s?\d{3}[A-Za-z]?$/.test(mod.name.trim());
  const { code, title } = onlyCode ? { code: mod.name.trim().toUpperCase(), title: "" } : splitName(mod.name);
  const isNew = d.mode === "new";
  const step = isNew ? (ui.job && ui.job.total > 1 ? `File ${ui.job.index} of ${ui.job.total} · Step 2 of 2` : ui.job ? "Step 2 of 2" : mod.shared ? "Shared module" : "Add by hand") : "Edit module";

  const rows = [];
  const shown = new Set();
  const groupBlock = g => {
    shown.add(g.id);
    rows.push(reviewGroupHtml(mod, g));
    mod.assessments.filter(a => a.groupId === g.id).forEach(a => rows.push(reviewRowHtml(mod, a)));
    rows.push(`<button class="link-acc indent sm" data-act="rv-add" data-gid="${g.id}">${ic("plus", 14)}Add to ${esc(g.name || "this group")}</button>`);
  };
  for (const a of mod.assessments) {
    const g = groupOf(mod, a);
    if (!g) rows.push(reviewRowHtml(mod, a));
    else if (!shown.has(g.id)) groupBlock(g);
  }
  mod.groups.filter(g => !shown.has(g.id)).forEach(groupBlock);

  el.innerHTML = `
    <div class="top-row between">
      <button class="back" data-act="rv-back">${ic("chevL")}${isNew ? "Back" : "Cancel"}</button>
      <div class="eyebrow">${esc(step)}</div>
    </div>
    <h1 class="h-screen h32">Check the weights</h1>
    <div class="code-name">
      <input class="box-input strong" data-in="rv-code" value="${esc(code)}" placeholder="Code" aria-label="Module code">
      <input class="box-input" data-in="rv-title" value="${esc(code || onlyCode ? title : mod.name)}" placeholder="Module name" aria-label="Module name">
    </div>
    <label class="field-row credits-row"><span class="meta14">Credits <span class="meta12">(for weighted averages)</span></span>
      <span class="num-box w80"><input type="number" inputmode="decimal" step="any" min="0" data-in="rv-credits" value="${esc(mod.credits || "")}" placeholder="e.g. 16" aria-label="Credits"></span></label>
    <label class="field-row credits-row"><span class="meta14">Exam admission <span class="meta12">(class mark of at least)</span></span>
      <span class="num-box w80"><input type="number" inputmode="decimal" step="any" min="0" max="100" data-in="rv-admission" value="${esc(mod.admission || "")}" placeholder="none" aria-label="Class mark needed for exam admission"><span>%</span></span></label>
    <div class="field-row colour-row"><span class="meta14">Colour</span>
      <span class="colour-pick">${MODULE_COLOURS.map(c => `<button class="mc-btn${mod.color === c ? " on" : ""}" data-act="rv-colour" data-c="${c}" aria-label="${c}" aria-pressed="${mod.color === c}"><i class="mc mc-${c}"></i></button>`).join("")}</span></div>
    <div class="rv-sum">
      <div id="rvSegs" class="segs"></div>
      <div class="row-between fs14"><span id="rvMsg"></span><b id="rvTotal" class="cond16"></b></div>
    </div>
    <div class="rv-table">
      <div class="grid-rv th"><span>Assessment</span><span class="r">Weight</span><span class="c">Final</span><span></span></div>
      ${rows.join("")}
      <div class="row-gap20">
        <button class="link-acc h48" data-act="rv-add">${ic("plus", 16)}Add assessment</button>
        <button class="link-acc h48" data-act="rv-add-group">${ic("layers", 16)}Add group</button>
      </div>
    </div>
    ${notesRulesHtml(mod)}
    <div class="rv-footer">
      <button id="rvSave" class="blueprint btn-solid" data-act="rv-save"><span></span></button>
      <button id="rvAnyway" class="link-acc center sm" data-act="rv-save-anyway" hidden>Save anyway (my framework adds up differently)</button>
    </div>`;
  paintReview();
  paintSplitPreview();
}

function reviewGroupHtml(mod, g) {
  return `
    <div class="rv-group" data-gid="${g.id}">
      <div class="grid-rvg">
        <input class="ghost-input group-name" data-in="g-name" value="${esc(g.name)}" aria-label="Group name">
        <label class="num-box acc"><input type="number" inputmode="decimal" step="any" data-in="g-weight" value="${esc(g.weight)}" aria-label="Group weight"><span>%</span></label>
        <span class="meta12 lh12">of the final mark</span>
        <button class="x" data-act="g-remove" aria-label="Remove group (keeps its assessments)">${ic("x", 16)}</button>
      </div>
      <div class="meta12 g-inner" id="inner-${g.id}"></div>
    </div>`;
}

function reviewRowHtml(mod, a) {
  const g = groupOf(mod, a);
  const date = dateFor(mod, a);
  const sub = Number(a.subMin) || 0;
  return `
    <div class="rv-row${g ? " in-group" : ""}" data-aid="${a.id}">
      <div class="grid-rv">
        <input class="ghost-input" data-in="a-name" value="${esc(a.name)}" placeholder="Name" aria-label="Assessment name">
        <label class="num-box"><input type="number" inputmode="decimal" step="any" data-in="a-weight" value="${esc(a.weight)}" aria-label="Weight"><span>%</span></label>
        <button class="dot${a.isFinal ? " on" : ""}" data-act="a-final" aria-label="Final test" aria-pressed="${!!a.isFinal}"><i></i></button>
        <button class="x" data-act="a-remove" aria-label="Remove">${ic("x", 16)}</button>
      </div>
      <div class="chips">
        ${date ? `<span class="chip plain">${dayMonth(date.date)}</span>` : ""}
        <button class="chip${sub ? " on" : ""}" data-act="a-sub">${sub ? `Sub-minimum ${fmt(sub)}%` : "+ Sub-minimum"}</button>
        ${a.isFinal ? "" : `<button class="chip" data-act="a-split">Split into parts</button>`}
        ${mod.groups.length ? `<select class="chip chip-select" data-ch="a-group" aria-label="Group">
          <option value="">Not in a group</option>${mod.groups.map(x => `<option value="${x.id}"${x.id === a.groupId ? " selected" : ""}>In ${esc(x.name || "group")}</option>`).join("")}
        </select>` : ""}
      </div>
      ${ui.splitFor === a.id ? splitPanelHtml(mod, a) : ""}
    </div>`;
}

// ---- Split into parts: one assessment ("Practicals 12.5%") becomes equal parts ----
// On its own it becomes a group with the same weight of the final mark, its parts sharing the
// group equally; inside a group, its share of the group is shared by the parts. Either way the
// parts together count exactly what the assessment counted, so the final mark doesn't change.

// "Tutorial quizzes 3x" → 3 parts named "Tutorial quiz"
const partsCount = name => {
  const m = String(name).match(/(\d{1,2})\s*[x×](?![a-z])|[x×]\s*(\d{1,2})\b|\((\d{1,2})\)/i);
  const n = m && Number(m[1] || m[2] || m[3]);
  return n >= 2 && n <= 30 ? n : 3;
};
const groupNameOf = name => String(name).replace(/\s*(\(?\d{1,2}\s*[x×]\)?|\(?[x×]\s*\d{1,2}\)?|\(\d{1,2}\))\s*$/i, "").trim() || String(name);
function singular(name) {
  const words = groupNameOf(name).replace(/\b(components?|sections?|marks?|total)\b/gi, "").replace(/\s+/g, " ").trim().split(" ");
  const last = words.pop() || "Part";
  const one = /zzes$/i.test(last) ? last.slice(0, -3) : /ies$/i.test(last) ? last.slice(0, -3) + "y"
    : /(ss|x|ch|sh)es$/i.test(last) ? last.slice(0, -2) : /[^s]s$/i.test(last) ? last.slice(0, -1) : last;
  return [...words, one].join(" ");
}

function splitPanelHtml(mod, a) {
  const n = ui.splitN || partsCount(a.name);
  const base = ui.splitName ?? singular(a.name);
  return `
    <div class="split-panel">
      <div class="split-row"><span class="fs14">Split into</span>
        <label class="num-box w64"><input type="number" inputmode="numeric" min="2" max="30" step="1" data-in="split-n" value="${n}" aria-label="Number of parts"></label>
        <span class="fs14">equal parts</span></div>
      <label class="split-name"><span class="meta12">Name of each part</span>
        <input class="box-input" data-in="split-name" value="${esc(base)}" aria-label="Name of each part"></label>
      <div id="splitPreview" class="meta13"></div>
      <div class="two-btns">
        <button class="btn-line h48" data-act="split-cancel">Cancel</button>
        <button class="blueprint btn-solid h48" data-act="split-do">Split</button>
      </div>
    </div>`;
}

// "Tutorial quiz 1, 2 and 3 · each 4.17% of the final mark (12.5% together)"
function paintSplitPreview() {
  const el = $("splitPreview");
  const mod = ui.draft && ui.draft.mod;
  const a = mod && mod.assessments.find(x => x.id === ui.splitFor);
  if (!el || !a) return;
  const n = clamp(Math.round(ui.splitN || partsCount(a.name)), 2, 30);
  const base = (ui.splitName ?? singular(a.name)).trim() || "Part";
  const each = effectiveWeight(mod, a) / n;
  const names = n <= 4 ? [...Array(n)].map((_, i) => `${base} ${i + 1}`).join(", ").replace(/, ([^,]*)$/, " and $1") : `${base} 1 to ${n}`;
  el.textContent = `${names} · each ${fmt(each, 2)}% of the final mark (${fmt(effectiveWeight(mod, a), 2)}% together)`;
}

ACTIONS["a-split"] = t => {
  ui.splitFor = t.closest("[data-aid]").dataset.aid;
  ui.splitN = null;
  ui.splitName = null;
  renderReview($("scrReview"));
  const input = document.querySelector('[data-in="split-n"]');
  if (input) input.focus();
};
ACTIONS["split-cancel"] = () => { ui.splitFor = null; renderReview($("scrReview")); };
INPUTS["split-n"] = t => { ui.splitN = parseInt(t.value, 10) || null; paintSplitPreview(); };
INPUTS["split-name"] = t => { ui.splitName = t.value; paintSplitPreview(); };
ACTIONS["split-do"] = () => {
  const m = ui.draft.mod;
  const a = m.assessments.find(x => x.id === ui.splitFor);
  if (!a) return;
  const n = clamp(Math.round(ui.splitN || partsCount(a.name)), 2, 30);
  const base = (ui.splitName ?? singular(a.name)).trim() || "Part";
  const mark = String(a.mark ?? "").trim(); // a mark already entered goes on every part, so nothing changes
  let groupId = a.groupId, weight;
  if (!a.groupId) {
    const g = { id: uid(), name: groupNameOf(a.name), weight: Number(a.weight) || 0 };
    m.groups.push(g);
    groupId = g.id;
    weight = Math.round((100 / n) * 10000) / 10000;
  } else {
    weight = Math.round(((Number(a.weight) || 0) / n) * 10000) / 10000;
  }
  const parts = [...Array(n)].map((_, i) => ({ id: uid(), name: `${base} ${i + 1}`, weight, mark, isFinal: false, groupId }));
  m.assessments.splice(m.assessments.indexOf(a), 1, ...parts);
  ui.splitFor = null;
  renderReview($("scrReview"));
  showToast(`Split into ${n} parts of ${fmt(effectiveWeight(m, parts[0]), 2)}% each. The final mark stays the same.`, 4000);
};

function notesRulesHtml(mod) {
  const notes = mod.notes || [], rules = mod.rules || [];
  if (!notes.length && !rules.length) return "";
  return `
    <div class="rules">
      <div class="eyebrow">Rules from your framework</div>
      ${notes.map(n => `<div class="rule note">${esc(n)}</div>`).join("")}
      ${rules.map(r => `<div class="rule">${esc(r)}</div>`).join("")}
    </div>`;
}

// The numbers that change while typing (the inputs themselves are left alone)
function paintReview() {
  const mod = ui.draft.mod;
  const { c, total, badGroup, ok } = reviewCheck(mod);
  $("rvSegs").innerHTML = c.rows.map(r => `<i style="flex:${Math.max(0, r.weight)};background:${r.a.isFinal ? "var(--color-accent-700)" : r.a.groupId ? "var(--color-accent-300)" : "var(--color-accent-400)"}"></i>`).join("") +
    (total < 100 ? `<i style="flex:${100 - total};background:var(--color-neutral-200)"></i>` : "");
  const msg = $("rvMsg");
  msg.textContent = !mod.assessments.length ? "No assessments yet. Add them below."
    : badGroup ? `${badGroup.name || "A group"}: its parts should add up to 100%.`
    : ok ? "Weights add up to 100%" : `Weights add up to ${fmt(total, 2)}%. They should add up to 100%.`;
  msg.className = ok ? "acc7" : "bad-text";
  $("rvTotal").textContent = fmt(total, 2) + "%";
  $("rvTotal").className = "cond16 " + (ok ? "acc7" : "bad-text");
  for (const g of mod.groups) {
    const el = $("inner-" + g.id);
    if (!el) continue;
    const inner = c.groupStats[g.id].inner;
    el.textContent = `Parts add up to ${fmt(inner, 2)}% of the group`;
    el.classList.toggle("bad-text", Math.abs(inner - 100) > 0.5);
  }
  const save = $("rvSave");
  save.classList.toggle("off", !ok);
  save.querySelector("span").textContent = ok ? (ui.draft.mode === "new" ? "Save module" : "Save changes") : "Weights must add up to 100%";
  $("rvAnyway").hidden = ok || !mod.assessments.length;
}

const draftA = t => ui.draft.mod.assessments.find(a => a.id === t.closest("[data-aid]").dataset.aid);
const draftG = t => ui.draft.mod.groups.find(g => g.id === t.closest("[data-gid]").dataset.gid);
const num = v => (v === "" ? 0 : parseFloat(String(v).replace(",", ".")) || 0);

INPUTS["rv-code"] = t => { const m = ui.draft.mod; m.name = joinName(t.value, document.querySelector('[data-in="rv-title"]').value); };
INPUTS["rv-title"] = t => { const m = ui.draft.mod; m.name = joinName(document.querySelector('[data-in="rv-code"]').value, t.value); };
INPUTS["a-name"] = t => (draftA(t).name = t.value);
INPUTS["a-weight"] = t => { draftA(t).weight = num(t.value); paintReview(); };
INPUTS["g-name"] = t => (draftG(t).name = t.value);
INPUTS["g-weight"] = t => { draftG(t).weight = num(t.value); paintReview(); };
ACTIONS["a-final"] = t => { const a = draftA(t); ui.draft.mod.assessments.forEach(x => (x.isFinal = x === a)); renderReview($("scrReview")); };
ACTIONS["a-remove"] = t => { const a = draftA(t); const m = ui.draft.mod; m.assessments = m.assessments.filter(x => x !== a); renderReview($("scrReview")); };
// Sub-minimum: none → 40% → 50% → none
ACTIONS["a-sub"] = t => { const a = draftA(t); const s = Number(a.subMin) || 0; a.subMin = s === 0 ? 40 : s === 40 ? 50 : null; renderReview($("scrReview")); };
CHANGES["a-group"] = t => {
  const a = draftA(t), m = ui.draft.mod;
  a.groupId = t.value || null;
  // keep it with its group's other rows
  m.assessments = m.assessments.filter(x => x !== a);
  const last = a.groupId ? m.assessments.map(x => x.groupId).lastIndexOf(a.groupId) : -1;
  m.assessments.splice(last >= 0 ? last + 1 : m.assessments.length, 0, a);
  renderReview($("scrReview"));
};
ACTIONS["g-remove"] = t => {
  // Keep the assessments, now counting directly towards the final mark
  const g = draftG(t), m = ui.draft.mod;
  m.assessments.forEach(a => { if (a.groupId === g.id) { a.weight = Math.round(effectiveWeight(m, a) * 10000) / 10000; a.groupId = null; } });
  m.groups = m.groups.filter(x => x !== g);
  renderReview($("scrReview"));
};
ACTIONS["rv-add"] = t => {
  const m = ui.draft.mod, gid = t.dataset.gid || null;
  const a = { id: uid(), name: "", weight: 0, mark: "", isFinal: !m.assessments.length, groupId: gid };
  const last = gid ? m.assessments.map(x => x.groupId).lastIndexOf(gid) : -1;
  if (last >= 0) m.assessments.splice(last + 1, 0, a); else m.assessments.push(a);
  renderReview($("scrReview"));
  const input = document.querySelector(`[data-aid="${a.id}"] [data-in="a-name"]`);
  if (input) input.focus();
};
ACTIONS["rv-add-group"] = () => {
  const m = ui.draft.mod, id = uid();
  m.groups.push({ id, name: "Class mark", weight: 40 });
  m.assessments.push({ id: uid(), name: "Test 1", weight: 50, mark: "", isFinal: false, groupId: id },
    { id: uid(), name: "Test 2", weight: 50, mark: "", isFinal: false, groupId: id });
  renderReview($("scrReview"));
  const input = document.querySelector(`[data-gid="${id}"] [data-in="g-name"]`);
  if (input) input.select();
};
ACTIONS["rv-back"] = () => {
  if (ui.draft.mode === "edit") { ui.draft = null; go("module"); return; }
  ui.draft = null; ui.queue = []; ui.job = null;
  go("add");
};
ACTIONS["rv-save"] = () => { if (reviewCheck(ui.draft.mod).ok) saveDraft(); };
ACTIONS["rv-save-anyway"] = saveDraft;

async function saveDraft() {
  const d = ui.draft;
  const m = d.mod;
  m.name = m.name.trim() || "New module";
  m.groups = m.groups.filter(g => m.assessments.some(a => a.groupId === g.id));
  if (d.mode === "edit") {
    const mod = state.modules.find(x => x.id === m.id);
    if (mod) Object.assign(mod, { name: m.name, credits: m.credits, color: m.color, admission: m.admission, groups: m.groups, assessments: m.assessments });
    ui.draft = null;
    saveState();
    go("module");
    return;
  }
  state.modules.push(m);
  state.onboarded = true;
  saveState();
  const pdf = ui.job && ui.job.draft === d ? ui.job.pdf : null;
  if (pdf) saveFile(m.id, pdf).catch(err => console.warn("Could not keep the PDF", err)); // for "Read again with AI"
  ui.draft = null;
  if (ui.queue.length) { showToast(`Saved ${m.name}. Next file…`, 2500); nextJob(); return; }
  ui.job = null;
  openModule(m.id, "modules");
}

// ---- 7. The module page ----

const GOALS = [[50, "Pass 50"], [60, "60"], [75, "Dist. 75"]];

function renderModulePage(el) {
  const mod = currentModule();
  if (!mod) return go("modules");
  const { code, title } = splitName(mod.name);
  const folder = state.folders.find(f => f.id === mod.folderId);
  const c = calculate(mod);
  const weightNote = !mod.assessments.length
    ? "No tests or assignments were found. Tap Edit to add them."
    : Math.abs(c.totalWeight - 100) > 0.01 ? `The weights add up to ${fmt(c.totalWeight, 2)}%, not 100%. Results are scaled to 100% for now; tap Edit to fix them.` : "";
  const source = mod.fileName
    ? `Read from ${mod.fileName}${mod.readBy === "ai" ? ` · by the AI${mod.aiInput === "pdf" ? " from the PDF" : mod.aiInput === "photo" ? " from a photo" : ""}` : ""}`
    : mod.example ? "Example module · delete it with the bin when you're done" : mod.pasted ? "From pasted text" : mod.shared ? "Shared by a classmate" : "Added by hand";
  const credits = Number(mod.credits) > 0 ? ` · ${fmt(mod.credits)} credits` : "";
  const custom = !GOALS.some(([g]) => g === Number(mod.target));

  // Rows in framework order; a group's rows are shown together under its heading
  const rows = [];
  const shown = new Set();
  for (const a of mod.assessments) {
    const g = groupOf(mod, a);
    if (!g) rows.push(moduleRowHtmlA(mod, a));
    else if (!shown.has(g.id)) {
      shown.add(g.id);
      rows.push(moduleGroupHtml(mod, g));
      mod.assessments.filter(x => x.groupId === g.id).forEach(x => rows.push(moduleRowHtmlA(mod, x)));
    }
  }

  el.innerHTML = `
    <div class="top-row between">
      <button class="back" data-act="leave-module">${ic("chevL")}${ui.from === "dates" ? "Key dates" : "My modules"}</button>
      <div class="row-gap6">
        <label class="tag-select"><select data-ch="mod-folder" aria-label="Folder">${folderOptions(mod.folderId)}</select><span>${esc(folder ? folder.name : "No folder")}</span></label>
        ${aiOn() && mod.sourceText ? `<button class="sq-icon" data-act="reread" aria-label="Read again with AI" title="Read again with AI">${ic("sparkles", 20)}</button>` : ""}
        <button class="sq-icon" data-act="share-module" aria-label="Share with classmates" title="Share with classmates">${ic("share", 20)}</button>
        <button class="sq-icon" data-act="edit-module" aria-label="Edit weights" title="Edit name and weights">${ic("pencil", 19)}</button>
        <button class="sq-icon" data-act="ask-delete" aria-label="Delete module" title="Delete module">${ic("trash", 20)}</button>
      </div>
    </div>
    <div class="mod-title">
      <div class="m-code big">${swatch(mod)}${esc(code)}</div>
      <h1 class="h-screen h34">${esc(title)}</h1>
      <div class="meta12">${esc(source + credits)}</div>
      ${weightNote ? `<div class="warn-line">${esc(weightNote)}</div>` : ""}
    </div>

    <div class="blueprint stats2">
      <div class="cell wide gap12">
        <div class="row-between base"><span id="heroLabel" class="eyebrow"></span><span id="heroGoal" class="meta12"></span></div>
        <div id="hero" class="hero80"></div>
        <div class="bar10 layered">
          <i id="barMax" class="max"></i><i id="barProj" class="proj"></i><i id="barNow" class="now"></i><b id="barGoal"></b>
        </div>
        <div id="heroSub" class="meta13"></div>
      </div>
      <div class="cell"><div class="eyebrow">Average on work done</div><div id="statAvg" class="num26"></div></div>
      <div class="cell"><div class="eyebrow">Weight completed</div><div id="statDone" class="num26"></div></div>
    </div>

    <div id="admitCard" class="admit-card" hidden>
      <div id="admitHead" class="row-between"><span class="eyebrow">Exam admission</span><span id="admitBadge" class="admit-badge"></span></div>
      <div id="admitText" class="fs14 lh135"></div>
      <div id="admitBarWrap" class="bar6"><i id="admitBar"></i><b id="admitGoal"></b></div>
      <div id="a3Text" class="fs14 lh135 a3"></div>
    </div>

    <div class="goal-panel">
      <div class="row-between">
        <div class="eyebrow on-dark">Final mark I want</div>
        <div class="goal-seg">
          ${GOALS.map(([g, label]) => `<button class="${Number(mod.target) === g ? "on" : ""}" data-act="goal" data-goal="${g}">${label}</button>`).join("")}
          <input class="${custom ? "on" : ""}" type="number" inputmode="decimal" min="0" max="100" placeholder="Other" aria-label="Other goal" data-ch="goal-other" value="${custom ? esc(mod.target) : ""}">
        </div>
      </div>
      <div class="need-row"><div id="needBig" class="hero64"></div><div id="needText" class="fs14 lh135"></div></div>
      <div id="subNote" class="sub-note" hidden></div>
    </div>

    <div class="assess">
      <div class="row-between pb10">
        <h2 class="h22">Assessments</h2>
        <button class="switch-row" data-act="what-if" aria-pressed="${ui.whatIf}"><span>What-if</span><span class="switch${ui.whatIf ? " on" : ""}"><i></i></span></button>
      </div>
      <div class="grid-ma th"><span>Assessment</span><span class="r">Weight</span><span class="r">Mark</span><span class="r">Counts</span></div>
      ${rows.join("")}
      <div class="meta12 pt10">Tap a row to enter a mark as a percentage (68) or a score (34/50).</div>
    </div>

    <div id="chartSec" class="chart-sec" hidden>
      <div class="row-between"><h2 class="h22">Progress</h2>
        <div class="legend"><span><i class="sw final"></i>Final mark so far</span><span><i class="sw avg"></i>Average on work done</span><span><i class="sw goal"></i>Goal ${fmt(Number(mod.target) || 0)}%</span></div></div>
      <div id="chartBox" class="chart-box"></div>
    </div>

    <div class="dates-sec">
      <div class="row-between"><h2 class="h22">Key dates</h2>
        <span class="row-gap12"><button class="link-acc" data-act="cal-module">${ic("calPlus", 16)}To calendar</button><button class="link-acc" data-act="add-date">${ic("plus", 16)}Add date</button></span></div>
      <div id="datesEdit">${datesEditorHtml(mod)}</div>
    </div>

    <div class="notes-sec">
      <div class="row-between"><h2 class="h22">Notes</h2><span id="memoSaved" class="meta12"></span></div>
      <textarea class="memo" data-in="memo" rows="3" placeholder="Topics for the test, the lecturer's email, anything you want to remember…" aria-label="Notes">${esc(mod.memo || "")}</textarea>
    </div>

    ${notesRulesHtml(mod)}`;
  paintModule();
  const memo = el.querySelector(".memo");
  if (memo && memo.value) requestAnimationFrame(() => fitMemo(memo));
  if (ui.entering) introduceModule();
}

function moduleGroupHtml(mod, g) {
  const kids = mod.assessments.filter(x => x.groupId === g.id);
  return `
    <div class="grid-ma ma-group" data-gid="${g.id}">
      <span class="g-names"><span class="g-name">${esc(g.name || "Group")}</span><span class="meta12">Group · ${kids.length} part${kids.length === 1 ? "" : "s"} · mark is the group average</span></span>
      <span class="r cond15">${fmt(Number(g.weight) || 0, 1)}%</span>
      <span class="r cond17" data-f="gmark"></span>
      <span class="r cond15" data-f="gcounts"></span>
    </div>`;
}

function moduleRowHtmlA(mod, a) {
  const g = groupOf(mod, a);
  return `
    <div class="ma-row${g ? " in-group" : ""}" data-aid="${a.id}" data-act="open-sheet" role="button" tabindex="0">
      <div class="grid-ma">
        <span class="a-names">
          <span class="a-top"><span class="a-name">${esc(a.name || "Unnamed")}</span>${a.isFinal ? `<span class="tag-final">Final test</span>` : ""}</span>
          <span class="meta12" data-f="meta"></span>
        </span>
        <span class="r cond15 dim">${fmt(effectiveWeight(mod, a), 1)}%</span>
        <span class="r cond17" data-f="mark"></span>
        <span class="r cond15" data-f="counts"></span>
      </div>
      <div class="wi-row" data-f="wi" hidden>
        <input type="range" min="0" max="100" step="1" data-in="wi" aria-label="What-if mark">
        <b class="cond15 acc7"></b>
      </div>
    </div>`;
}

// The what-if mark for an assessment that isn't marked yet (starts at what's needed)
const wiValue = (p, a) => ui.wi[a.id] ?? clamp(Math.ceil(p.need ?? 50), 0, 100);

// Fills in every number on the module page (also while dragging a what-if slider)
function paintModule() {
  const mod = currentModule();
  if (!mod || ui.screen !== "module") return;
  const p = plan(mod);
  const goal = p.goal;
  const wiOn = ui.whatIf && p.pending.length > 0;
  const proj = (p.earned + p.pending.reduce((s, r) => s + wiValue(p, r.a) * r.weight / 100, 0)) * p.scale;
  const wiFailsSub = wiOn && p.pending.some(r => r.a.subMin && wiValue(p, r.a) < r.a.subMin);
  const failedSub = p.rows.find(r => r.a.subMin && hasMark(r) && r.pct < r.a.subMin);

  $("heroLabel").textContent = wiOn ? "Projected final mark" : "Final mark so far";
  $("heroGoal").textContent = `goal ${fmt(goal)}%`;
  const hero = $("hero");
  hero.textContent = r1(wiOn ? proj : p.finalSoFar) + "%";
  hero.className = "hero80" + (wiOn ? (wiFailsSub || proj < goal ? " bad-text" : " acc7") : "");
  $("barNow").style.transform = `scaleX(${clamp(p.finalSoFar, 0, 100) / 100})`;
  $("barProj").style.transform = `scaleX(${wiOn ? clamp(proj, 0, 100) / 100 : 0})`;
  $("barMax").style.width = clamp(p.finalSoFar + p.remPct, 0, 100) + "%";
  $("barGoal").style.left = clamp(goal, 0, 100) + "%";
  $("heroSub").textContent = wiOn
    ? (wiFailsSub ? "Fails a sub-minimum, so the module is not passed." : proj >= goal ? `Reaches your ${fmt(goal)}% goal.` : `${r1(goal - proj)} short of your ${fmt(goal)}% goal.`)
    : !p.rows.length ? "Add the module's assessments to start." : p.pending.length ? `Out of 100%. ${r1(p.remPct)}% of the module is still to come.` : "Out of 100%. All marks are in.";
  $("statAvg").textContent = p.average === null ? "–" : r1(p.average) + "%";
  $("statDone").textContent = r1(p.donePct) + "%";

  // What's needed to reach the goal
  let big, text, tone = "";
  const fin = p.finalRow;
  if (!p.rows.length) { big = "–"; text = "Add the assessments first."; }
  else if (p.need === null) { const met = p.finalSoFar >= goal; big = met ? "Met" : "Missed"; text = `Final mark ${r1(p.finalSoFar)}%.`; tone = met ? "good" : "bad"; }
  else if (p.need <= 0) { big = "0%"; text = `${fmt(goal)}% is already banked.`; tone = "good"; }
  else if (p.need > 100) { big = Math.ceil(p.need) + "%"; text = `Out of reach. Full marks on the rest gives ${r1(p.finalSoFar + p.remPct)}%.`; tone = "bad"; }
  else if (p.onlyFinal) { big = Math.ceil(Math.max(p.need, Number(fin.a.subMin) || 0)) + "%"; text = `needed in ${fin.a.name || "the final test"} to finish on ${fmt(goal)}%`; }
  else { big = Math.ceil(p.need) + "%"; text = `average needed on the ${r1(p.remPct)}% still to come`; }
  $("needBig").textContent = big;
  $("needBig").className = "hero64 " + tone;
  $("needText").textContent = text;
  const subPend = p.pending.filter(r => r.a.subMin);
  const subNote = failedSub ? `${failedSub.a.name} is below its ${fmt(failedSub.a.subMin)}% sub-minimum.`
    : subPend.length ? `${subPend.map(r => `${r.a.name} has a ${fmt(r.a.subMin)}% sub-minimum`).join("; ")}, so you need at least that there whatever your other marks.` : "";
  $("subNote").hidden = !subNote;
  $("subNote").textContent = subNote;
  paintAdmission(mod, p);

  // Rows
  for (const r of p.rows) {
    const row = document.querySelector(`.ma-row[data-aid="${r.a.id}"]`);
    if (!row) continue;
    const a = r.a, pend = !hasMark(r), invalid = Number.isNaN(r.pct);
    const failSub = a.subMin && !pend && r.pct < a.subMin;
    const g = groupOf(mod, a);
    const date = dateFor(mod, a);
    const bits = [];
    if (g) bits.push(`${fmt(Number(a.weight) || 0, 2)}% of ${g.name}`);
    if (date) { const n = daysUntil(date.date); bits.push(pend && n >= 0 ? `${dayMonth(date.date)} · ${whenText(n).toLowerCase()}` : dayMonth(date.date)); }
    if (a.subMin) bits.push(failSub ? `below ${fmt(a.subMin)}% sub-min` : `sub-min ${fmt(a.subMin)}%`);
    const meta = row.querySelector('[data-f="meta"]');
    meta.textContent = bits.join(" · ");
    meta.classList.toggle("bad-text", !!failSub);
    const showWi = wiOn && pend;
    const wv = wiValue(p, a);
    const mark = row.querySelector('[data-f="mark"]');
    mark.textContent = invalid ? "Fix" : pend ? (showWi ? wv + "%" : "Add") : fmt(r.pct, 1) + "%";
    mark.className = "r cond17 " + (invalid || failSub ? "bad-text" : pend ? "acc7" : "");
    row.querySelector('[data-f="counts"]').textContent = pend ? (showWi ? r1(wv * r.weight / 100) : "–") : r1(r.pct * r.weight / 100);
    const wiRow = row.querySelector('[data-f="wi"]');
    wiRow.hidden = !showWi;
    if (showWi) {
      const slider = wiRow.querySelector("input");
      if (document.activeElement !== slider) slider.value = wv;
      wiRow.querySelector("b").textContent = wv + "%";
    }
  }
  for (const g of mod.groups) {
    const row = document.querySelector(`.ma-group[data-gid="${g.id}"]`);
    if (!row) continue;
    const kids = p.rows.filter(r => r.a.groupId === g.id && hasMark(r));
    row.querySelector('[data-f="gmark"]').textContent = p.groupStats[g.id]?.average == null ? "–" : r1(p.groupStats[g.id].average) + "%";
    row.querySelector('[data-f="gcounts"]').textContent = kids.length ? r1(kids.reduce((s, r) => s + r.pct * r.weight / 100, 0)) : "–";
  }
  const sw = document.querySelector(".switch");
  if (sw) sw.classList.toggle("on", ui.whatIf);
  drawChart(mod, goal);
}

ACTIONS["leave-module"] = leaveModule;
ACTIONS.goal = t => { currentModule().target = Number(t.dataset.goal); ui.wi = {}; saveState(); renderModulePage($("scrModule")); };
CHANGES["goal-other"] = t => {
  const v = parseFloat(String(t.value).replace(",", "."));
  if (!(v >= 0 && v <= 100)) return;
  currentModule().target = v;
  ui.wi = {};
  saveState();
  renderModulePage($("scrModule"));
};
ACTIONS["what-if"] = () => { ui.whatIf = !ui.whatIf; ui.wi = {}; paintModule(); document.querySelector(".switch-row").setAttribute("aria-pressed", String(ui.whatIf)); };
INPUTS.wi = t => { ui.wi[t.closest("[data-aid]").dataset.aid] = Number(t.value); paintModule(); };
document.addEventListener("click", e => { if (e.target.closest(".wi-row")) e.stopPropagation(); }, true);
CHANGES["mod-folder"] = t => {
  const mod = currentModule();
  mod.folderId = t.value || null;
  saveState();
  renderModulePage($("scrModule"));
};
ACTIONS["edit-module"] = () => {
  ui.splitFor = null;
  ui.draft = { mode: "edit", mod: JSON.parse(JSON.stringify(currentModule())) };
  go("review");
};
ACTIONS.reread = rereadWithAi;
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("ma-row")) { e.preventDefault(); e.target.click(); }
});

// The module's own list of dates, to fix or add dates
function datesEditorHtml(mod) {
  const sorted = [...(mod.dates || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time || "").localeCompare(String(b.time || "")));
  if (!sorted.length) return `<div class="meta13 pt6">No dates found in the framework. Add the dates of tests and due dates to see them on Key dates.</div>`;
  return sorted.map(d => {
    const n = d.date ? daysUntil(d.date) : null;
    return `
      <div class="de-row${n !== null && n < 0 ? " past" : ""}" data-did="${d.id}">
        <input class="ghost-input de-label" data-in="d-label" value="${esc(d.label)}" placeholder="e.g. Test 1" aria-label="What">
        <button class="x" data-act="d-remove" aria-label="Remove date">${ic("x", 16)}</button>
        <div class="de-when">
          <input class="box-input date" type="date" data-ch="d-date" value="${esc(d.date || "")}" aria-label="Date">
          <input class="box-input time" type="time" data-ch="d-time" value="${esc(d.time || "")}" aria-label="Time (optional)">
          <span class="meta12 de-count${n !== null && n >= 0 && n <= 7 ? " acc7" : ""}">${n === null ? "" : n < 0 ? "done" : whenText(n).toLowerCase()}</span>
        </div>
        <input class="ghost-input de-venue" data-in="d-venue" value="${esc(d.venue || "")}" placeholder="Venue (optional)" aria-label="Venue">
      </div>`;
  }).join("");
}
const modDate = t => {
  const mod = currentModule();
  mod.dates = mod.dates || [];
  const id = t.closest("[data-did]").dataset.did;
  return mod.dates.find(d => String(d.id) === id);
};
INPUTS["d-label"] = t => { modDate(t).label = t.value; saveState(); };
CHANGES["d-date"] = t => { modDate(t).date = t.value; saveState(); $("datesEdit").innerHTML = datesEditorHtml(currentModule()); paintModule(); };
ACTIONS["d-remove"] = t => {
  const mod = currentModule(), d = modDate(t);
  const i = mod.dates.indexOf(d);
  mod.dates.splice(i, 1);
  saveState();
  $("datesEdit").innerHTML = datesEditorHtml(mod);
  paintModule();
  undoable(`Removed ${d.label || "the date"}.`, () => {
    mod.dates.splice(Math.min(i, mod.dates.length), 0, d);
    saveState();
    if (ui.screen === "module" && currentModule() === mod) { $("datesEdit").innerHTML = datesEditorHtml(mod); paintModule(); } else render();
  });
};
ACTIONS["add-date"] = () => {
  const mod = currentModule();
  mod.dates = mod.dates || [];
  const d = { id: uid(), label: "", date: todayIso() };
  mod.dates.push(d);
  saveState();
  $("datesEdit").innerHTML = datesEditorHtml(mod);
  const input = document.querySelector(`[data-did="${d.id}"] [data-in="d-label"]`);
  if (input) input.focus();
};
// Older dates have no id yet
state.modules.forEach(m => (m.dates || []).forEach(d => { if (!d.id) d.id = uid(); }));

// "Read again with AI": replaces the assessments, keeping marks of assessments with the same name
async function rereadWithAi() {
  const mod = currentModule();
  if (!mod || !mod.sourceText) return;
  if (!confirm(`Let the AI read "${mod.name}" again? Its assessments and key dates will be replaced. Marks you entered are kept for assessments with the same name.`)) return;
  const btn = document.querySelector('[data-act="reread"]');
  if (btn) btn.disabled = true;
  showToast("The AI is reading the framework again…", 60000);
  try {
    const pdf = /\.pdf$/i.test(mod.fileName || "") ? await loadFile(mod.id) : null;
    const { parsed, readBy } = chooseReading(await aiRead(mod.sourceText, msg => showToast(msg, 60000), pdf), mod.sourceText);
    const old = mod.assessments.filter(a => String(a.mark).trim() || a.subMin);
    parsed.assessments.forEach(a => {
      const o = old.find(x => norm(x.name) === norm(a.name)) || old.find(x => sameName(x.name, a.name));
      if (o) { a.mark = o.mark; if (o.subMin) a.subMin = o.subMin; }
    });
    Object.assign(mod, { groups: parsed.groups, assessments: parsed.assessments, notes: parsed.notes, rules: parsed.rules, readBy,
      dates: parsed.dates && parsed.dates.length ? parsed.dates : mod.dates || [],
      aiInput: readBy === "ai" ? parsed.input : undefined });
    findSubMinimums(mod);
    findAdmission(mod);
    saveState();
    showToast("Read again. Check the weights.", 4000);
    if (ui.screen === "module") renderModulePage($("scrModule"));
  } catch (err) {
    showToast("The AI couldn't read this framework: " + err.message, 8000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- 8. The mark sheet (slides up from the bottom; drag it down to close) ----

const sheet = { el: null, back: null, closing: false, drag: null };
const translateY = el => { const t = getComputedStyle(el).transform; return !t || t === "none" ? 0 : new DOMMatrixReadOnly(t).m42; };

ACTIONS["open-sheet"] = t => {
  const mod = currentModule();
  const a = mod && mod.assessments.find(x => x.id === t.dataset.aid);
  if (!a) return;
  ui.editing = a.id;
  const layer = $("sheetLayer");
  const g = groupOf(mod, a);
  const ew = effectiveWeight(mod, a);
  layer.innerHTML = `
    <div class="backdrop" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(a.name)}">
      <div class="handle"></div>
      <div class="row-between start">
        <div class="col2"><div class="h24">${esc(a.name || "Unnamed")}</div>
          <div class="meta13">${fmt(ew, 2)}% of the final mark${g ? ` (${fmt(Number(a.weight) || 0, 2)}% of ${esc(g.name)})` : ""}${a.subMin ? ` · sub-minimum ${fmt(a.subMin)}%` : ""}</div></div>
        <button class="link-acc pad6" data-act="sheet-clear">Clear</button>
      </div>
      <div class="sheet-entry">
        <input id="sheetInput" class="big-input" inputmode="decimal" placeholder="68 or 34/50" autocomplete="off" value="${esc(a.mark || "")}" data-in="sheet-raw" aria-label="Your mark">
        <div id="sheetHint" class="fs14 hint"></div>
      </div>
      <input id="sheetSlider" type="range" min="0" max="100" step="1" data-in="sheet-slide" aria-label="Mark">
      <div class="two-cells">
        <div><div class="eyebrow sm">Counts for</div><div id="sheetCounts" class="cond20"></div></div>
        <div><div class="eyebrow sm">Final mark so far</div><div id="sheetFinal" class="cond20"></div></div>
      </div>
      <button class="blueprint btn-solid" data-act="sheet-save">Save mark</button>
    </div>`;
  layer.hidden = false;
  sheet.el = layer.querySelector(".sheet");
  sheet.back = layer.querySelector(".backdrop");
  sheet.closing = false;
  const r = reduceMotion();
  sheet.el.animate(r ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], { duration: r ? 160 : 440, easing: DRAWER });
  sheet.back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
  sheet.el.addEventListener("pointerdown", sheetDown);
  sheet.el.addEventListener("pointermove", sheetMove);
  sheet.el.addEventListener("pointerup", sheetUp);
  sheet.el.addEventListener("pointercancel", sheetUp);
  paintSheet();
  if (matchMedia("(pointer: fine)").matches) $("sheetInput").focus();
};

function paintSheet() {
  const mod = currentModule();
  const a = mod.assessments.find(x => x.id === ui.editing);
  const raw = $("sheetInput").value;
  const v = parseMark(raw);
  const ok = v !== null && !Number.isNaN(v);
  const ew = effectiveWeight(mod, a);
  const hint = $("sheetHint");
  hint.textContent = v === null ? "Percentage or score"
    : !ok ? "Type a number like 68 or 34/50"
    : a.subMin && v < a.subMin ? `Below the ${fmt(a.subMin)}% sub-minimum`
    : raw.includes("/") ? `= ${r1(v)}%` : " ";
  hint.classList.toggle("bad-text", !ok && v !== null || (ok && a.subMin && v < a.subMin));
  const slider = $("sheetSlider");
  if (document.activeElement !== slider) slider.value = ok ? Math.round(v) : 0;
  $("sheetCounts").textContent = ok ? `${r1(v * ew / 100)} of ${fmt(ew, 1)}` : "–";
  const after = calculate({ ...mod, assessments: mod.assessments.map(x => (x.id === a.id ? { ...x, mark: ok ? raw : "" } : x)) });
  $("sheetFinal").textContent = r1(after.finalSoFar) + "%";
}
INPUTS["sheet-raw"] = () => paintSheet();
INPUTS["sheet-slide"] = t => { $("sheetInput").value = t.value; paintSheet(); };

ACTIONS["sheet-save"] = () => {
  const mod = currentModule();
  const a = mod.assessments.find(x => x.id === ui.editing);
  const raw = $("sheetInput").value.trim();
  const v = parseMark(raw);
  if (v !== null && Number.isNaN(v)) { $("sheetInput").focus(); return; }
  const before = goalMet(plan(mod));
  a.mark = raw;
  ui.wi = {};
  saveState();
  const after = plan(mod);
  closeSheet();
  paintModule();
  if (!before && goalMet(after)) celebrate(after); else buzz();
};
ACTIONS["sheet-clear"] = () => {
  const mod = currentModule();
  mod.assessments.find(x => x.id === ui.editing).mark = "";
  saveState();
  closeSheet();
  paintModule();
};
ACTIONS["sheet-close"] = () => closeSheet();
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("sheetLayer").hidden) closeSheet();
  if (e.key === "Enter" && e.target.id === "sheetInput") ACTIONS["sheet-save"]();
});

function closeSheet() {
  const el = sheet.el;
  if (!el) return closeSheetNow();
  if (sheet.closing) return;
  sheet.closing = true;
  const y = translateY(el), h = el.offsetHeight, r = reduceMotion();
  el.getAnimations().forEach(a => a.cancel());
  el.style.transform = `translateY(${y}px)`;
  const anim = el.animate(r ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: `translateY(${y}px)` }, { transform: `translateY(${h}px)` }], { duration: 260, easing: DRAWER, fill: "forwards" });
  if (sheet.back) {
    const op = parseFloat(getComputedStyle(sheet.back).opacity);
    sheet.back.getAnimations().forEach(a => a.cancel());
    sheet.back.animate([{ opacity: op }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" });
  }
  anim.onfinish = closeSheetNow;
}
function closeSheetNow() {
  const layer = $("sheetLayer");
  layer.hidden = true;
  layer.innerHTML = "";
  Object.assign(sheet, { el: null, back: null, closing: false, drag: null });
  ui.editing = null;
}

// Drag by the handle or body (not the inputs). Upwards it rubber-bands; a quick flick
// or dragging it past 45% of its height closes it, otherwise it snaps back.
const rubber = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * o);
function sheetDown(e) {
  if (sheet.closing || sheet.drag || e.target.closest("input, textarea, button")) return;
  sheet.drag = { id: e.pointerId, y0: e.clientY, start: 0, hist: [], live: false };
}
function sheetMove(e) {
  const d = sheet.drag, el = sheet.el;
  if (!d || !el || e.pointerId !== d.id) return;
  if (!d.live) {
    if (Math.abs(e.clientY - d.y0) < 8) return;
    const y0 = translateY(el);
    el.getAnimations().forEach(a => a.cancel());
    d.start = e.clientY - y0;
    d.live = true;
    el.setPointerCapture(e.pointerId);
  }
  let y = e.clientY - d.start;
  if (y < 0) y = -rubber(-y, el.offsetHeight);
  el.style.transform = `translateY(${y}px)`;
  if (sheet.back) sheet.back.style.opacity = String(Math.max(0, 1 - Math.max(0, y) / el.offsetHeight));
  d.hist.push({ y, t: e.timeStamp });
  if (d.hist.length > 5) d.hist.shift();
}
function sheetUp(e) {
  const d = sheet.drag;
  if (!d || e.pointerId !== d.id) return;
  sheet.drag = null;
  if (!d.live) return;
  const el = sheet.el, h = el.offsetHeight, y = translateY(el);
  const a = d.hist[0], b = d.hist[d.hist.length - 1];
  const v = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
  const projected = y + (v * 0.998) / (1 - 0.998);
  if (v > 0.5 || (v >= 0 && projected > h * 0.45)) return closeSheet();
  el.style.transform = "";
  el.animate([{ transform: `translateY(${y}px)` }, { transform: "translateY(0)" }], { duration: 340, easing: EASE_OUT });
  if (sheet.back) {
    const op = parseFloat(sheet.back.style.opacity || "1");
    sheet.back.style.opacity = "";
    sheet.back.animate([{ opacity: op }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }
}

// ---- 9. Delete a module ----

// Deleting a module happens straight away, with Undo; its saved PDF goes once Undo has gone
ACTIONS["ask-delete"] = () => {
  const mod = currentModule();
  const i = state.modules.indexOf(mod);
  const { code, title } = splitName(mod.name);
  buzz();
  state.modules.splice(i, 1);
  saveState();
  leaveModule();
  undoable(`Deleted ${code || title}.`, () => {
    state.modules.splice(Math.min(i, state.modules.length), 0, mod);
    saveState();
    render();
  }, () => deleteFile(mod.id));
};
function closeDialog(after) {
  const layer = $("dlgLayer");
  const dlg = layer.querySelector(".dlg"), back = layer.querySelector(".dlg-back");
  const done = () => { layer.hidden = true; layer.innerHTML = ""; if (after) after(); };
  if (!dlg) return done();
  const o = { duration: 150, easing: "ease-out", fill: "forwards" };
  dlg.animate([{ transform: "none" }, { transform: reduceMotion() ? "none" : "scale(0.98)" }], o);
  back.animate([{ opacity: 1 }, { opacity: 0 }], o).onfinish = done;
}
ACTIONS["dlg-cancel"] = () => closeDialog();
// The glass header frosts only once something has scrolled under it
const markScrolled = () => document.body.classList.toggle("scrolled", window.scrollY > 4);
window.addEventListener("scroll", markScrolled, { passive: true });

// Shows whether the AI reader is on, in Settings
function renderAiState() {
  const on = aiOn();
  $("aiState").textContent = on ? "On" : "Off";
  $("aiState").classList.toggle("on", on);
}

// A short message at the bottom of the screen, optionally with a button (e.g. Undo)
function showToast(text, ms = 6000, action = null) {
  let toast = $("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ""}`;
  toast.classList.toggle("has-action", !!action);
  if (action) toast.querySelector(".toast-btn").addEventListener("click", () => { toast.classList.remove("show"); action.run(); });
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), ms);
}

// ---------- AI reader settings ----------

const aiDialog = $("aiDialog");
const aiStatus = (text, kind = "") => { $("aiStatus").textContent = text; $("aiStatus").className = `ai-status ${kind}`; };

$("aiBtn").addEventListener("click", () => {
  const s = loadAi();
  $("aiKey").value = s.key || "";
  $("aiModel").value = s.model || "";
  aiStatus(s.key ? "The AI reader is on. New frameworks are read by the AI." : "");
  aiDialog.showModal();
});
$("aiClose").addEventListener("click", () => aiDialog.close());
$("aiSave").addEventListener("click", () => {
  const key = $("aiKey").value.trim();
  if (!key) { aiStatus("Paste your API key first.", "bad"); return; }
  saveAi({ key, model: $("aiModel").value.trim() });
  renderAiState();
  aiStatus("Saved. The AI reader is on: new frameworks are read by the AI.", "good");
  if (ui.screen === "add" || ui.screen === "module") render();
});
$("aiRemove").addEventListener("click", () => {
  try { localStorage.removeItem(AI_STORAGE_KEY); } catch (e) { /* ignore */ }
  $("aiKey").value = "";
  $("aiModel").value = "";
  renderAiState();
  aiStatus("The AI reader is off and the key is removed from this device.");
  if (ui.screen === "add" || ui.screen === "module") render();
});
$("aiTest").addEventListener("click", async () => {
  const key = $("aiKey").value.trim();
  if (!key) { aiStatus("Paste your API key first.", "bad"); return; }
  const before = loadAi();
  saveAi({ key, model: $("aiModel").value.trim() }); // test exactly what's typed
  aiStatus("Testing…");
  try {
    const { model } = await callGemini({ contents: [{ role: "user", parts: [{ text: "Reply with the word OK." }] }] }, msg => aiStatus(msg));
    aiStatus(`It works! (model: ${model}). Tap Save to keep it.`, "good");
  } catch (err) {
    aiStatus(err.message, "bad");
  } finally {
    if (before.key) saveAi(before); else try { localStorage.removeItem(AI_STORAGE_KEY); } catch (e) { /* ignore */ }
    renderAiState();
  }
});

// ---------- Light, dark, or follow the phone/computer (kept per device) ----------

const THEME_KEY = "markCalc.theme";
function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll("[data-theme-choice]").forEach(b => {
    const active = b.dataset.themeChoice === (choice || "auto");
    b.classList.toggle("on", active);
    b.setAttribute("aria-checked", String(active));
  });
  const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0b0d14" : "#eef1f7";
}
let themeChoice = "auto";
try { themeChoice = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { /* ignore */ }
applyTheme(themeChoice);
document.querySelectorAll("[data-theme-choice]").forEach(b => b.addEventListener("click", e => {
  themeChoice = b.dataset.themeChoice;
  try { localStorage.setItem(THEME_KEY, themeChoice); } catch (err) { /* ignore */ }
  applyTheme(themeChoice);
}));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themeChoice));

// ---------- Phone app (installable web app) ----------
// Android and desktop Chrome/Edge offer an install prompt; Safari on iPhone needs "Add to Home Screen".

let installPrompt = null;
const runningAsApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault(); // show our own button instead of the browser's banner
  installPrompt = e;
  $("installBtn").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("installBtn").hidden = true;
});
if (isIos && !runningAsApp()) $("installBtn").hidden = false;

$("installBtn").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === "accepted") $("installBtn").hidden = true;
  } else {
    $("installDialog").showModal();
  }
});
$("installClose").addEventListener("click", () => $("installDialog").close());

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline support not available", err));
}

// ---------- Backup / restore (marks are stored per browser, so this moves them between devices) ----------

$("exportBtn").addEventListener("click", () => {
  state.lastBackup = new Date().toISOString();
  saveState();
  askToKeepData();
  if (ui.screen === "settings") renderSettings();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mark-calculator-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("importInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.modules)) throw new Error("Not a Mark Calculator backup.");
    if (!confirm("Replace your current modules with this backup?")) return;
    state = upgradeState(data);
    state.modules.forEach(m => (m.dates || []).forEach(d => { if (!d.id) d.id = uid(); }));
    state.onboarded = true;
    ensureColours();
    state.selectedId = null;
    saveState();
    go("modules");
    showToast(`Restored ${state.modules.length} module${state.modules.length === 1 ? "" : "s"}.`);
  } catch (err) {
    alert("Could not restore: " + err.message);
  }
});

// ---------- Credits: averages weighted by each module's credits ----------

// Average on work done over several modules. Weighted by credits when every module with
// marks has its credits filled in; otherwise a plain average (and how many still need credits).
function averageOf(mods) {
  const done = mods.map(m => ({ m, avg: calculate(m).average })).filter(x => x.avg != null);
  if (!done.length) return { value: null, weighted: false, missing: 0, credits: 0 };
  const credits = x => Number(x.m.credits) > 0 ? Number(x.m.credits) : 0;
  const missing = done.filter(x => !credits(x)).length;
  if (!missing) {
    const total = done.reduce((s, x) => s + credits(x), 0);
    return { value: done.reduce((s, x) => s + x.avg * credits(x), 0) / total, weighted: true, missing: 0, credits: total };
  }
  return { value: done.reduce((s, x) => s + x.avg, 0) / done.length, weighted: false, missing, someCredits: done.length > missing };
}

ACTIONS["rv-colour"] = t => {
  ui.draft.mod.color = t.dataset.c;
  document.querySelectorAll(".mc-btn").forEach(b => { const on = b === t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
};
INPUTS["rv-credits"] = t => {
  const v = parseFloat(String(t.value).replace(",", "."));
  ui.draft.mod.credits = v > 0 ? v : undefined;
};

// ---------- Add key dates to the phone's calendar (.ics file) ----------
// All-day events with a reminder at 09:00 the day before. Each date keeps the same id,
// so adding them again updates the events in most calendar apps instead of doubling them.

// Nearest colour names (calendar files only take names); some calendar apps ignore them
const ICS_COLOURS = { blue: "royalblue", orange: "darkorange", aqua: "mediumseagreen", yellow: "goldenrod", magenta: "palevioletred", green: "green", violet: "slateblue" };

function calendarFile(mods) {
  const text = s => String(s).replace(/[\\;,]/g, ch => "\\" + ch).replace(/\r?\n/g, "\\n");
  // Lines longer than 75 characters are folded, as the calendar format requires
  const fold = line => line.length <= 74 ? line : line.match(/.{1,73}/g).join("\r\n ");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const nextDay = iso => {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    return t.toISOString().slice(0, 10).replace(/-/g, "");
  };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mark Calculator//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  let count = 0;
  const rem = REMINDERS[settings().reminder] || REMINDERS.day9;
  for (const m of mods) {
    const { code, title } = splitName(m.name);
    for (const d of m.dates || []) {
      if (!d.date || !d.label || daysUntil(d.date) < 0) continue;
      const a = assessmentFor(m, d.label);
      const about = a ? `${d.label} counts ${fmt(effectiveWeight(m, a), 1)}% of your final mark for ${m.name}.` : `${m.name}`;
      // With a time: a 2-hour event at that time, and the reminder on the chosen day and hour
      const hm = /^(\d{1,2}):(\d{2})$/.exec(String(d.time || ""));
      const [y, mo, da] = d.date.split("-").map(Number);
      const when = hm
        ? [`DTSTART:${icsLocal(new Date(y, mo - 1, da, +hm[1], +hm[2]))}`, `DTEND:${icsLocal(new Date(y, mo - 1, da, +hm[1] + 2, +hm[2]))}`]
        : [`DTSTART;VALUE=DATE:${d.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(d.date)}`];
      const trigger = !rem.trigger ? null : hm
        ? `TRIGGER;VALUE=DATE-TIME:${icsUtc(new Date(y, mo - 1, da - rem.days, rem.hour, 0))}`
        : `TRIGGER:${rem.trigger}`;
      lines.push("BEGIN:VEVENT",
        `UID:${m.id}-${d.id}@markcalculator`,
        `DTSTAMP:${stamp}`,
        ...when,
        ...(String(d.venue || "").trim() ? [fold(`LOCATION:${text(d.venue.trim())}`)] : []),
        fold(`SUMMARY:${text(`${code || title}: ${d.label}`)}`),
        fold(`DESCRIPTION:${text(about)}`),
        `COLOR:${ICS_COLOURS[m.color] || "steelblue"}`,
        hm ? "TRANSP:OPAQUE" : "TRANSP:TRANSPARENT",
        ...(trigger ? ["BEGIN:VALARM", "ACTION:DISPLAY", trigger, fold(`DESCRIPTION:${text(`${rem.text}: ${code || title} ${d.label}`)}`), "END:VALARM"] : []),
        "END:VEVENT");
      count++;
    }
  }
  lines.push("END:VCALENDAR");
  return { ics: lines.join("\r\n") + "\r\n", count };
}

async function addToCalendar(mods, name) {
  const { ics, count } = calendarFile(mods);
  if (!count) { showToast("There are no coming dates to add. Add dates on a module's page first."); return; }
  const base = name.replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-") || "key-dates";
  if (isIos) {
    // Safari only opens a calendar file in Calendar ("Add All") when it comes from the website,
    // so the offline helper (sw.js) hands it back from this address
    const url = new URL("calendar.ics", location.href);
    url.searchParams.set("n", base);
    url.searchParams.set("d", toB64url(new TextEncoder().encode(ics)));
    try {
      const res = navigator.serviceWorker && navigator.serviceWorker.controller ? await fetch(url) : null;
      if (res && res.ok && /text\/calendar/.test(res.headers.get("Content-Type") || "")) {
        location.href = url.href;
        return;
      }
    } catch (e) { /* fall back to a download below */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = base + ".ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  showToast(isIos
    ? `Downloaded ${count} date${count === 1 ? "" : "s"}. Open Files → Downloads and tap the file to add ${count === 1 ? "it" : "them"} to Calendar.`
    : `Downloaded ${count} date${count === 1 ? "" : "s"}. Open the file to add ${count === 1 ? "it" : "them"} to your calendar.`, 8000);
}
ACTIONS["cal-module"] = () => { const m = currentModule(); addToCalendar([m], `${m.name} key dates`); };
ACTIONS["cal-all"] = () => addToCalendar(state.modules, "Key dates");

// ---------- Share a module with classmates ----------
// The link holds the module's weights, groups, rules and key dates (never marks), packed into
// the part of the address after "#", which is never sent to a server.

const toB64url = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = str => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, ch => ch.charCodeAt(0));
};
const streamBytes = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function shareLink(mod) {
  const gi = id => mod.groups.findIndex(g => g.id === id);
  const data = {
    v: 1, n: mod.name, c: Number(mod.credits) || 0, t: Number(mod.target) || 50, x: Number(mod.admission) || 0,
    g: mod.groups.map(g => [g.name, Number(g.weight) || 0]),
    a: mod.assessments.map(a => [a.name, Number(a.weight) || 0, a.groupId ? gi(a.groupId) : -1, a.isFinal ? 1 : 0, Number(a.subMin) || 0]),
    r: mod.rules || [],
    d: (mod.dates || []).filter(d => d.date && d.label).map(d => (d.time || d.venue ? [d.date, d.label, d.time || "", d.venue || ""] : [d.date, d.label])),
  };
  const json = new TextEncoder().encode(JSON.stringify(data));
  let payload = "j" + toB64url(json);
  if (window.CompressionStream) {
    try { payload = "z" + toB64url(await streamBytes(json, new CompressionStream("deflate-raw"))); } catch (e) { /* plain is fine */ }
  }
  return `${location.origin}${location.pathname}#m=${payload}`;
}

async function readShared(payload) {
  let bytes = fromB64url(payload.slice(1));
  if (payload[0] === "z") {
    if (!window.DecompressionStream) throw new Error("This browser is too old to open shared modules. Update it, or open the link in Chrome or Safari.");
    bytes = await streamBytes(bytes, new DecompressionStream("deflate-raw"));
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || data.v !== 1 || !Array.isArray(data.a)) throw new Error("This link doesn't hold a module.");
  const groups = (data.g || []).map(([name, weight]) => ({ id: uid(), name: String(name), weight: Number(weight) || 0 }));
  return {
    id: uid(), name: String(data.n || "Shared module"), fileName: "", shared: true,
    credits: Number(data.c) > 0 ? Number(data.c) : undefined, admission: Number(data.x) > 0 ? Number(data.x) : undefined, target: Number(data.t) || settings().defaultGoal,
    folderId: state.uploadFolderId || null, groups,
    assessments: data.a.map(([name, weight, g, fin, sub]) => ({
      id: uid(), name: String(name), weight: Number(weight) || 0, mark: "", isFinal: !!fin,
      groupId: groups[g] ? groups[g].id : null, subMin: Number(sub) > 0 ? Number(sub) : undefined,
    })),
    notes: [], rules: (data.r || []).map(String), dates: (data.d || []).map(([date, label, time, venue]) => ({ id: uid(), date: String(date), label: String(label), ...(time ? { time: String(time) } : {}), ...(venue ? { venue: String(venue) } : {}) })),
  };
}

// Opening a shared link: the module goes to Check the weights, ready to save
async function openSharedFromAddress() {
  const m = location.hash.match(/^#m=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const mod = await readShared(m[1]);
    state.onboarded = true;
    saveState();
    ui.queue = [];
    ui.job = null;
    ui.draft = { mode: "new", mod };
    go("review");
    showToast("A classmate shared this module with you. Check the weights and tap Save module.", 7000);
  } catch (err) {
    console.warn(err);
    showToast("Couldn't open the shared module: " + err.message, 8000);
  }
  return true;
}
window.addEventListener("hashchange", openSharedFromAddress);

// Loads the QR code drawer only when someone shares (it's saved for offline use after that)
let qrLoading = null;
const loadQr = () => qrLoading || (qrLoading = new Promise((resolve, reject) => {
  if (window.QRCode) return resolve();
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  s.onload = resolve;
  s.onerror = () => { qrLoading = null; reject(new Error("QR code unavailable offline")); };
  document.head.appendChild(s);
}));

ACTIONS["share-module"] = async () => {
  const mod = currentModule();
  const { code, title } = splitName(mod.name);
  const link = await shareLink(mod);
  const layer = $("dlgLayer");
  layer.innerHTML = `
    <div class="dlg-back" data-act="dlg-cancel">
      <div class="blueprint dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
        <div id="dlgTitle" class="h24">Share ${esc(code || title)}</div>
        <div class="fs14 lh15 dim8">Classmates get the weights, groups, rules and key dates, so they don't have to upload the framework. Your marks are not shared.</div>
        <div id="qrBox" class="qr-box"><span class="meta12">Making the QR code…</span></div>
        <div class="meta12 c">Scan with a phone camera, or send the link.</div>
        <div class="two-btns">
          <button class="btn-line h48" data-act="share-copy">Copy link</button>
          <button class="blueprint btn-solid h48" data-act="share-send">Send link</button>
        </div>
        <button class="link-acc center sm" data-act="dlg-cancel">Close</button>
      </div>
    </div>`;
  layer.hidden = false;
  layer.dataset.link = link;
  const dlg = layer.querySelector(".dlg");
  dlg.addEventListener("click", e => { if (!e.target.closest("[data-act]")) e.stopPropagation(); });
  dlg.animate([{ opacity: 0, transform: reduceMotion() ? "none" : "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: EASE_OUT });
  layer.querySelector(".dlg-back").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  if (!navigator.share) {
    layer.querySelector('[data-act="share-send"]').hidden = true;
    layer.querySelector(".two-btns").classList.add("one");
  }
  try {
    await loadQr();
    const box = $("qrBox");
    if (!box) return;
    box.innerHTML = "";
    new QRCode(box, { text: link, width: 220, height: 220, colorDark: "#1d1f20", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.L });
    box.removeAttribute("title"); // the library puts the whole link in a tooltip
  } catch (err) {
    const box = $("qrBox");
    if (box) box.innerHTML = `<span class="meta12">${err.message.includes("offline") ? "The QR code needs internet the first time. Copy or send the link instead." : "This module is too big for a QR code. Copy or send the link instead."}</span>`;
  }
};
ACTIONS["share-copy"] = async () => {
  const link = $("dlgLayer").dataset.link;
  try { await navigator.clipboard.writeText(link); showToast("Link copied. Paste it in a message to your classmates.", 4000); }
  catch (e) { prompt("Copy this link:", link); }
};
ACTIONS["share-send"] = async () => {
  const mod = currentModule();
  try { await navigator.share({ title: `${mod.name} for Mark Calculator`, text: `${mod.name}: weights and key dates for Mark Calculator`, url: $("dlgLayer").dataset.link }); }
  catch (e) { /* cancelled */ }
};

// ---------- Progress chart: the final mark so far and the average after each mark ----------
// One line per measure, both in % on one axis, with the goal as a dashed line. Marks are taken
// in the order the framework lists the assessments (usually the order they're written).

function progressPoints(mod) {
  const c = calculate(mod);
  const scale = c.totalWeight > 0 ? 100 / c.totalWeight : 0;
  let earned = 0, done = 0;
  return c.rows.filter(r => hasMark(r) && r.weight > 0).map(r => {
    earned += r.pct * r.weight / 100;
    done += r.weight;
    return { name: r.a.name || "Unnamed", mark: r.pct, final: earned * scale, avg: earned / done * 100 };
  });
}

function drawChart(mod, goal) {
  const box = $("chartBox");
  if (!box) return;
  const pts = progressPoints(mod);
  $("chartSec").hidden = false;
  if (pts.length < 2) {
    box.innerHTML = `<div class="meta13 chart-empty">The chart appears once you have marks for two assessments.</div>`;
    return;
  }
  const W = Math.max(260, box.clientWidth), H = 190;
  const pad = { l: 34, r: 46, t: 12, b: 26 };
  const x = i => pad.l + (W - pad.l - pad.r) * (i / (pts.length - 1));
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - clamp(v, 0, 100) / 100);
  const path = key => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const short = s => (s.length > 14 ? s.slice(0, 13) + "…" : s);
  const last = pts[pts.length - 1];
  // Direct labels at the end of each line, kept apart if they're close
  let yf = y(last.final), ya = y(last.avg);
  if (Math.abs(yf - ya) < 14) { const mid = (yf + ya) / 2; const up = yf < ya ? -7 : 7; yf = mid + up; ya = mid - up; }
  box.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Final mark so far went from ${r1(pts[0].final)}% to ${r1(last.final)}%; average on work done is ${r1(last.avg)}%.">
      ${[0, 25, 50, 75, 100].map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      <line class="goal" x1="${pad.l}" x2="${W - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>
      <path class="line avg" d="${path("avg")}"/>
      <path class="line final" d="${path("final")}"/>
      ${pts.map((p, i) => `<rect class="pt avg" x="${x(i) - 4}" y="${y(p.avg) - 4}" width="8" height="8"/><rect class="pt final" x="${x(i) - 4}" y="${y(p.final) - 4}" width="8" height="8"/>`).join("")}
      <text class="end final" x="${W - pad.r + 8}" y="${yf + 4}">${r1(last.final)}%</text>
      <text class="end avg" x="${W - pad.r + 8}" y="${ya + 4}">${r1(last.avg)}%</text>
      <text class="axis" x="${pad.l}" y="${H - 6}">${esc(short(pts[0].name))}</text>
      <text class="axis" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${esc(short(last.name))}</text>
      <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
    </svg>
    <div class="chart-tip" hidden></div>`;

  // Point at (or drag a finger along) the chart to read the numbers after each mark
  const svg = box.querySelector("svg"), cross = svg.querySelector(".cross"), tip = box.querySelector(".chart-tip");
  const show = e => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    let i = Math.round((px - pad.l) / ((W - pad.l - pad.r) / (pts.length - 1)));
    i = clamp(i, 0, pts.length - 1);
    const p = pts[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>After ${esc(p.name)}</b> (${r1(p.mark)}%)<span><i class="sw final"></i>Final so far ${r1(p.final)}%</span><span><i class="sw avg"></i>Average ${r1(p.avg)}%</span>`;
    const left = clamp(x(i) - tip.offsetWidth / 2, 0, W - tip.offsetWidth);
    tip.style.left = left + "px";
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}
window.addEventListener("resize", () => {
  if (ui.screen !== "module") return;
  clearTimeout(drawChart.t);
  drawChart.t = setTimeout(() => { const m = currentModule(); if (m) drawChart(m, Number(m.target) || 0); }, 150);
});

// ---------- Motion: numbers count up, bars grow and rows arrive one after another ----------
// Only when a screen is arrived at (not while you work on it), and not at all with "reduce motion".

function countUp(el, to, decimals = settings().decimals) {
  if (!el || reduceMotion() || !(to > 0)) return;
  const finalText = el.textContent;
  const tok = String(Math.random());
  el.dataset.countTok = tok;
  const start = performance.now(), dur = 650;
  const frame = now => {
    if (el.dataset.countTok !== tok) return;
    const t = clamp((now - start) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = t < 1 ? fmt(to * eased, decimals) + "%" : finalText;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Bars start empty and grow to their value
function growBars(bars, firstDelay = 120) {
  if (reduceMotion()) return;
  bars.forEach((bar, i) => {
    const target = bar.style.transform;
    bar.style.transition = "none";
    bar.style.transform = "scaleX(0)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = "";
      bar.style.transitionDelay = firstDelay + Math.min(i, 10) * 40 + "ms";
      bar.style.transform = target;
      setTimeout(() => (bar.style.transitionDelay = ""), 1200);
    }));
  });
}

// My modules: the cards and rows arrive 40ms apart, the bars grow and the numbers count up
function introduce(el) {
  if (reduceMotion()) return;
  [...el.querySelectorAll(".next-up, .summary-row, .empty, #moduleList > li")].slice(0, 12).forEach((it, i) => {
    it.style.animationDelay = i * 40 + "ms";
    it.classList.add("arrive");
  });
  growBars([...el.querySelectorAll(".bar6 > i, .f-bar > i")]);
  el.querySelectorAll("[data-count]").forEach(n => countUp(n, parseFloat(n.dataset.count)));
}

// A module's page: the final mark and what's needed count up, the bar grows
function introduceModule() {
  if (reduceMotion()) return;
  countUp($("hero"), parseFloat($("hero").textContent));
  const need = $("needBig");
  if (/%$/.test(need.textContent)) countUp(need, parseFloat(need.textContent), 0);
  growBars([$("barNow")], 80);
}

// "Goal reached": a short moment when a mark you save makes the goal banked
function celebrate(p) {
  const fin = p.finalRow;
  const sub = fin && !hasMark(fin) && Number(fin.a.subMin) > 0 ? Number(fin.a.subMin) : 0;
  const text = p.need === null ? `You finished on ${r1(p.finalSoFar)}%.`
    : sub ? `${fmt(p.goal)}% is banked. Just get the ${fmt(sub)}% sub-minimum in ${fin.a.name || "the final test"}.`
    : `${fmt(p.goal)}% is banked, whatever happens in the rest.`;
  const box = document.createElement("div");
  box.className = "celebrate";
  box.setAttribute("role", "status");
  box.innerHTML = `<div class="blueprint cele"><span class="cele-tick">${ic("check", 30)}</span><div class="h24">Goal reached</div><div class="meta13">${esc(text)}</div></div>`;
  document.body.appendChild(box);
  haptic([10, 60, 20]);
  const card = box.firstElementChild, r = reduceMotion();
  card.animate(r ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE_OUT });
  card.querySelector(".cele-tick").animate(r ? [{ opacity: 1 }, { opacity: 1 }] : [{ transform: "scale(0.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 360, delay: 120, easing: EASE_OUT, fill: "backwards" });
  let gone = false;
  const close = () => {
    if (gone) return;
    gone = true;
    card.animate([{ opacity: 1 }, { opacity: 0, transform: r ? "none" : "scale(0.97)" }], { duration: 180, easing: "ease-out", fill: "forwards" }).onfinish = () => box.remove();
  };
  box.addEventListener("click", close);
  setTimeout(close, 2200);
}

// ---------- Exam admission ----------
// Many modules need a minimum class mark before you may write the exam (e.g. "a class mark of at
// least 40% for admission"). The class mark is a group named like "Class mark" when the module has
// one, otherwise everything except the final test.

const CLASS_GROUP = /\b(class|klas|semester|year|jaar)\b|klaspunt|predikaat|jaarpunt/i;
const SECOND_CHANCE = /\bA3\b|second opportunity|tweede geleentheid|supplementar|re-?exam|herexam/i;

function classMark(mod) {
  const c = calculate(mod);
  const g = mod.groups.find(x => CLASS_GROUP.test(x.name || ""));
  const rows = g ? c.rows.filter(r => r.a.groupId === g.id) : c.rows.filter(r => r !== c.finalRow);
  const w = r => (g ? Number(r.a.weight) || 0 : r.weight); // weights inside the class mark
  const total = rows.reduce((s, r) => s + w(r), 0);
  if (!(total > 0)) return null;
  const marked = rows.filter(hasMark);
  const doneW = marked.reduce((s, r) => s + w(r), 0);
  const earned = marked.reduce((s, r) => s + (r.pct * w(r)) / 100, 0);
  const rem = total - doneW;
  const needed = Number(mod.admission) || 0;
  return {
    avg: doneW > 0 ? (earned / doneW) * 100 : null,
    done: rem <= 1e-6,
    value: (earned / total) * 100, // the class mark if everything still to come scored 0
    need: rem > 1e-6 ? ((needed / 100) * total - earned) / rem * 100 : null,
    needed,
    name: g ? (/^[A-Z][a-z]/.test(g.name) ? g.name.charAt(0).toLowerCase() + g.name.slice(1) : g.name) : "class mark",
  };
}

// "A class mark of at least 40% is needed for admission to the exam" → 40
function findAdmission(mod) {
  if (Number(mod.admission) > 0) return;
  for (const rule of mod.rules || []) {
    if (!/admission|admitted|toelating|toegelaat|toegang|entry|access to the exam|allowed to write|qualify|eligible|deelnamebewys/i.test(rule)) continue;
    const m = rule.match(/(\d{2}(?:[.,]\d+)?)\s*%/);
    const pct = m && parseFloat(m[1].replace(",", "."));
    if (pct >= 20 && pct <= 75) { mod.admission = pct; return; }
  }
}

// Does the framework offer a second chance (A3, supplementary exam)?
const hasSecondChance = mod =>
  [...(mod.rules || []), ...(mod.notes || []), ...(mod.dates || []).map(d => d.label || "")].some(t => SECOND_CHANCE.test(t));

// The admission card on a module's page, and what you'd need in A3 if A2 went wrong
function paintAdmission(mod, p) {
  const card = $("admitCard");
  if (!card) return;
  const lines = [];
  let badge = "", tone = "", show = false;
  const cm = Number(mod.admission) > 0 ? classMark(mod) : null;
  if (cm) {
    show = true;
    const n = fmt(cm.needed);
    if (cm.done) {
      const ok = cm.value >= cm.needed;
      badge = ok ? "Admitted" : "Not admitted"; tone = ok ? "good" : "bad";
      lines.push(`Your ${cm.name} is ${r1(cm.value)}%; you need at least ${n}% to write the exam.`);
    } else if (cm.need <= 0) {
      badge = "Admitted"; tone = "good";
      lines.push(`You already have enough for the ${n}% needed to write the exam, whatever your other class marks.`);
    } else if (cm.need > 100) {
      badge = "Out of reach"; tone = "bad";
      lines.push(`Even full marks on the rest of your class work won't reach the ${n}% needed to write the exam. Talk to your lecturer.`);
    } else {
      const need = Math.ceil(cm.need);
      badge = `Need ${need}%`; tone = need > settings().risk ? "bad" : "";
      lines.push(`${cm.avg == null ? "No class marks yet." : `Your ${cm.name} on work done is ${r1(cm.avg)}%.`} You need an average of ${need}% on the rest of your class work to reach the ${n}% needed to write the exam.`);
    }
    $("admitBar").style.transform = `scaleX(${clamp(cm.done ? cm.value : cm.avg ?? 0, 0, 100) / 100})`;
    $("admitBar").className = tone === "good" ? "done" : "";
    $("admitGoal").style.left = clamp(cm.needed, 0, 100) + "%";
  }
  $("admitBarWrap").hidden = !cm;
  $("admitHead").hidden = !cm;

  // A2 written and the goal (or its sub-minimum) missed: what would be needed in A3, which replaces it
  const fin = p.finalRow;
  let a3 = "";
  if (fin && hasMark(fin) && hasSecondChance(mod)) {
    const sub = Number(fin.a.subMin) || 0;
    const failed = p.finalSoFar < p.goal || (sub && fin.pct < sub);
    if (failed && fin.weight > 0) {
      const others = p.earned - (fin.pct * fin.weight) / 100;
      const needA3 = Math.max(((p.goal / p.scale - others) / fin.weight) * 100, sub);
      a3 = needA3 > 100
        ? `If you write A3 (it replaces ${shortLabel(fin.a.name || "A2")}), even 100% would give ${r1((others + fin.weight) * p.scale)}%.`
        : `If you write A3 (it replaces ${shortLabel(fin.a.name || "A2")}), you'd need ${Math.ceil(needA3)}% in it to finish on ${fmt(p.goal)}%.`;
      show = true;
    }
  }
  $("admitText").textContent = lines.join(" ");
  $("admitText").hidden = !lines.length;
  $("a3Text").textContent = a3;
  $("a3Text").hidden = !a3;
  const b = $("admitBadge");
  b.textContent = badge;
  b.className = "admit-badge " + tone;
  b.hidden = !badge;
  card.hidden = !show;
}

INPUTS["rv-admission"] = t => {
  const v = parseFloat(String(t.value).replace(",", "."));
  ui.draft.mod.admission = v > 0 && v <= 100 ? v : undefined;
};

// ---------- Keeping marks safe ----------
// Marks live only on this device. The app asks the browser to keep its data, remembers when the
// last Backup was made, and now and then suggests one. (Safari on iPhone can clear a website's data
// after about 7 days without a visit; apps added to the Home Screen aren't affected.)

async function askToKeepData() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      ui.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch (e) { /* not available */ }
}
const daysSince = iso => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 864e5)) : null);
const agoText = d => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);

function backupNudgeHtml() {
  const mods = state.modules;
  if (!mods.some(m => m.assessments.some(a => String(a.mark ?? "").trim()))) return "";
  const d = daysSince(state.lastBackup);
  if ((d !== null && d < 21) || Date.now() < (state.nudgeUntil || 0)) return "";
  const safari = isIos && !runningAsApp();
  return `
    <div class="nudge">
      <div class="row-between"><span class="eyebrow">${d === null ? "Keep your marks safe" : `Last backup ${agoText(d)}`}</span>
        <button class="link-acc sm" data-act="nudge-later">Later</button></div>
      <p class="fs14 lh135">${safari
        ? "Safari can clear a website's data if it isn't opened for about a week. Add the app to your Home Screen, or save a Backup file."
        : "Your marks are stored only on this device. Save a Backup file now and then, so you can restore them on a new phone."}</p>
      <div class="two-btns${safari ? "" : " one"}">
        ${safari ? `<button class="btn-line h48" data-act="nudge-install">Add to Home Screen</button>` : ""}
        <button class="blueprint btn-solid h48" data-act="nudge-backup">Back up now</button>
      </div>
    </div>`;
}

ACTIONS["nudge-backup"] = () => { $("exportBtn").click(); render(); };
ACTIONS["nudge-install"] = () => $("installDialog").showModal();
ACTIONS["nudge-later"] = () => { state.nudgeUntil = Date.now() + 14 * 864e5; saveState(); render(); };

// ---------- Undo instead of "Are you sure?" ----------
// Deleting a module, folder or key date happens straight away, with "Undo" in a message for a few
// seconds. Anything that can't be taken back (a saved PDF) is only removed once Undo has gone.

let pendingUndo = null;
function undoable(text, undo, commit) {
  if (pendingUndo) pendingUndo.commit(); // an earlier delete can't be undone any more
  const entry = { done: false, commit: () => { if (entry.done) return; entry.done = true; pendingUndo = null; if (commit) commit(); } };
  pendingUndo = entry;
  showToast(text, 6000, {
    label: "Undo",
    run: () => { if (entry.done) return; entry.done = true; pendingUndo = null; undo(); showToast("Restored.", 2000); },
  });
  clearTimeout(undoable.timer);
  undoable.timer = setTimeout(() => entry.commit(), 6200);
}
// Leaving the app: whatever is waiting is final
window.addEventListener("pagehide", () => { if (pendingUndo) pendingUndo.commit(); });

// ---------- Key dates: time and venue ----------

// "09:00 · Hall A"
const dateExtra = d => [d.time, d.venue].map(s => String(s || "").trim()).filter(Boolean).join(" · ");

INPUTS["d-venue"] = t => { modDate(t).venue = t.value; saveState(); };
CHANGES["d-time"] = t => { modDate(t).time = t.value; saveState(); };

// A local date and time in the calendar file's format
const icsLocal = dt => `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}${String(dt.getMinutes()).padStart(2, "0")}00`;
const icsUtc = dt => dt.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

// ---------- Notes per module ----------

// The notes box grows with what's written (only once it's on screen and has its width)
function fitMemo(t) {
  if (!t.offsetWidth) return;
  t.style.height = "auto";
  t.style.height = t.scrollHeight + 2 + "px";
}
INPUTS.memo = t => {
  const mod = currentModule();
  if (!mod) return;
  mod.memo = t.value;
  fitMemo(t);
  clearTimeout(INPUTS.memo.timer);
  INPUTS.memo.timer = setTimeout(() => { saveState(); const s = $("memoSaved"); if (s) s.textContent = "Saved"; }, 400);
};

// ---------- Try with an example ----------

function exampleModule() {
  const t = new Date();
  const day = k => { const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + k); return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const used = new Set(state.modules.map(m => m.color));
  return {
    id: uid(), name: "BIO 112 Cell Biology", example: true, fileName: "", target: settings().defaultGoal, folderId: null, credits: 12,
    color: MODULE_COLOURS.find(c => !used.has(c)) || "blue",
    groups: [],
    assessments: [
      { id: uid(), name: "Class Test 1", weight: 15, mark: "64", isFinal: false, groupId: null },
      { id: uid(), name: "Assignment 1", weight: 10, mark: "36/50", isFinal: false, groupId: null },
      { id: uid(), name: "Class Test 2", weight: 15, mark: "", isFinal: false, groupId: null },
      { id: uid(), name: "Practical Report", weight: 10, mark: "", isFinal: false, groupId: null },
      { id: uid(), name: "A2 (Final test)", weight: 50, mark: "", isFinal: true, groupId: null, subMin: 40 },
    ],
    notes: [],
    rules: ["Students need a sub-minimum of 40% in A2 to pass the module.", "A final mark of at least 50% is required to pass."],
    dates: [
      { id: uid(), label: "Class Test 2", date: day(5), time: "14:00", venue: "Room 1004" },
      { id: uid(), label: "Practical Report", date: day(12) },
      { id: uid(), label: "A2 (Final test)", date: day(30), time: "09:00", venue: "Hall A" },
    ],
    memo: "This is an example module. Tap Class Test 2 to enter a mark, or turn on What-if. Delete it with the bin at the top when you're done.",
  };
}
ACTIONS["try-example"] = () => {
  state.onboarded = true;
  const mod = exampleModule();
  state.modules.push(mod);
  saveState();
  openModule(mod.id, "modules");
  showToast("An example module to try things out. Delete it whenever you like.", 4500);
};

// ---------- Year overview ----------
// Your averages for the whole year or one folder (semester), credits passed, and what average you
// still need on the work to come to reach a goal average (75% = cum laude at most universities).

const PASS_MARK = 50;
const YEAR_GOALS = [[60, "60"], [70, "70"], [75, "Cum laude 75"], [80, "80"]];

function yearSummary(mods) {
  const ps = mods.map(m => ({ m, p: plan(m) })).filter(x => x.p.rows.length);
  const credited = ps.every(x => Number(x.m.credits) > 0);
  const w = x => (credited ? Number(x.m.credits) : 1);
  const W = ps.reduce((s, x) => s + w(x), 0);
  const credits = { total: 0, passed: 0, failed: 0, coming: 0 };
  for (const x of ps) {
    const c = Number(x.m.credits) || 0;
    credits.total += c;
    if (x.p.need === null) { if (x.p.finalSoFar >= PASS_MARK) credits.passed += c; else credits.failed += c; }
    else credits.coming += c;
  }
  const banked = ps.reduce((s, x) => s + w(x) * x.p.finalSoFar, 0);       // final marks so far, weighted
  const rem = ps.reduce((s, x) => s + w(x) * x.p.remPct / 100, 0);         // share of the average still to come
  // If every module keeps its own average on work done for the rest
  const keepGoing = W ? ps.reduce((s, x) => s + w(x) * (x.p.finalSoFar + (x.p.average ?? 0) * x.p.remPct / 100), 0) / W : null;
  return { ps, credited, W, banked, rem, credits, keepGoing, avg: averageOf(mods) };
}

function renderOverview(el) {
  const scope = state.folders.some(f => f.id === state.overviewScope) ? state.overviewScope : "all";
  const mods = scope === "all" ? state.modules : state.modules.filter(m => m.folderId === scope);
  const goal = Number(state.yearGoal) || 75;
  const y = yearSummary(mods);
  const custom = !YEAR_GOALS.some(([g]) => g === goal);

  // What average is still needed on the rest to reach the goal
  let big = "–", text = "Add modules and marks to see this.", tone = "";
  if (y.W) {
    if (y.rem <= 1e-6) {
      const fin = y.banked / y.W;
      big = r1(fin) + "%"; text = fin >= goal ? `Your average is ${r1(fin)}%: ${fmt(goal)}% reached.` : `Your final average is ${r1(fin)}%, below ${fmt(goal)}%.`;
      tone = fin >= goal ? "good" : "bad";
    } else {
      const need = (goal * y.W - y.banked) / y.rem;
      if (need <= 0) { big = "0%"; text = `${fmt(goal)}% is already banked, whatever happens in the rest.`; tone = "good"; }
      else if (need > 100) { big = Math.ceil(need) + "%"; text = `Out of reach. Full marks on everything still to come gives ${r1((y.banked + y.rem * 100) / y.W)}%.`; tone = "bad"; }
      else { big = Math.ceil(need) + "%"; text = `average needed on all your work still to come for a ${fmt(goal)}% average`; }
    }
  }
  const c = y.credits;
  const pct = n => (c.total ? (n / c.total) * 100 : 0);

  el.innerHTML = `
    <div class="title-block">
      <h1 class="h-screen">Overview</h1>
      <div class="meta14">${scope === "all" ? "All your modules" : esc((state.folders.find(f => f.id === scope) || {}).name || "")}${y.credited ? " · weighted by credits" : y.ps.length ? " · add credits to each module to weight by credits" : ""}</div>
    </div>
    ${state.folders.length ? `
    <div class="scope-pills" role="tablist">
      <button class="chip${scope === "all" ? " on" : ""}" data-act="ov-scope" data-scope="all">All</button>
      ${state.folders.map(f => `<button class="chip${scope === f.id ? " on" : ""}" data-act="ov-scope" data-scope="${f.id}">${esc(f.name || "Folder")}</button>`).join("")}
    </div>` : ""}
    ${!y.ps.length ? `
    <div class="blueprint empty">
      <div class="eyebrow">Nothing here yet</div>
      <p>Your averages, credits and what you need for cum laude appear here once you have modules with marks.</p>
    </div>` : `
    <div class="blueprint stats2">
      <div class="cell wide"><div class="eyebrow">Average on work done</div>
        <div class="hero64" data-count="${y.avg.value ?? ""}">${y.avg.value == null ? "–" : r1(y.avg.value) + "%"}</div>
        ${y.keepGoing != null ? `<div class="meta13">If you keep this up in every module: about ${r1(y.keepGoing)}% at the end.</div>` : ""}</div>
      <div class="cell"><div class="eyebrow">Credits passed</div><div class="num26">${c.total ? `${fmt(c.passed)} of ${fmt(c.total)}` : "–"}</div>
        <div class="meta12">${c.total ? `${fmt(c.coming)} still to come${c.failed ? ` · ${fmt(c.failed)} not passed` : ""}` : "Add credits on each module"}</div></div>
      <div class="cell"><div class="eyebrow">Modules</div><div class="num26">${y.ps.length}</div>
        <div class="meta12">${y.ps.filter(x => statusOf(x.m).bad).length} at risk</div></div>
      ${c.total ? `<div class="cell wide-bottom"><span class="credit-bar" aria-hidden="true"><i class="passed" style="width:${pct(c.passed)}%"></i><i class="coming" style="width:${pct(c.coming)}%"></i><i class="failed" style="width:${pct(c.failed)}%"></i></span>
        <span class="credit-legend"><span><i class="passed"></i>Passed</span><span><i class="coming"></i>Still to come</span>${c.failed ? `<span><i class="failed"></i>Not passed</span>` : ""}</span></div>` : ""}
    </div>

    <div class="goal-panel">
      <div class="row-between">
        <div class="eyebrow on-dark">Average I want</div>
        <div class="goal-seg wrap">
          ${YEAR_GOALS.map(([g, label]) => `<button class="${goal === g ? "on" : ""}" data-act="ov-goal" data-goal="${g}">${label}</button>`).join("")}
          <input class="${custom ? "on" : ""}" type="number" inputmode="decimal" min="0" max="100" placeholder="Other" aria-label="Other goal average" data-ch="ov-goal-other" value="${custom ? esc(goal) : ""}">
        </div>
      </div>
      <div class="need-row"><div class="hero64 ${tone}">${big}</div><div class="fs14 lh135">${esc(text)}</div></div>
      <div class="sub-note">Cum laude usually needs a weighted average of 75% over your degree, and some universities have extra rules (for example no failed modules). Check your faculty's rules.</div>
    </div>

    <div class="ov-list">
      <div class="row-between pb10"><h2 class="h22">Modules</h2><span class="meta12">Final mark so far</span></div>
      ${y.ps.map(x => {
        const { code, title } = splitName(x.m.name);
        const st = statusOf(x.m);
        return `
        <button class="ov-row press" data-act="open-module" data-id="${x.m.id}">
          <span class="ov-name">${swatch(x.m)}<span><b>${esc(code || title)}</b>${code ? ` <span class="meta12">${esc(title)}</span>` : ""}</span></span>
          <span class="ov-mark">${r1(x.p.finalSoFar)}%</span>
          <span class="meta12 ov-meta">${Number(x.m.credits) > 0 ? `${fmt(x.m.credits)} credits · ` : ""}<span class="${st.bad ? "bad-text" : ""}">${esc(st.text)}</span></span>
        </button>`;
      }).join("")}
    </div>`}`;
  if (ui.entering) introduce(el);
}
ACTIONS["ov-scope"] = t => { state.overviewScope = t.dataset.scope === "all" ? null : t.dataset.scope; saveState(); renderOverview($("scrOverview")); };
ACTIONS["ov-goal"] = t => { state.yearGoal = Number(t.dataset.goal); saveState(); renderOverview($("scrOverview")); };
CHANGES["ov-goal-other"] = t => {
  const v = parseFloat(String(t.value).replace(",", "."));
  if (v > 0 && v <= 100) { state.yearGoal = v; saveState(); }
  renderOverview($("scrOverview"));
};

// ---------- Start ----------
// The intro the first time; after that, the clean list with every folder closed

state.selectedId = null;
state.folders.forEach(f => (f.collapsed = true));
if (state.modules.length) state.onboarded = true;
registerSettingsActions();
askToKeepData();
ensureColours();
applySettings();
saveState();
ui.screen = state.onboarded ? "modules" : "onboarding";
ui.anim = "fade";
render();
openSharedFromAddress();
