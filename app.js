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

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Could not save", e);
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
  };

  for (const line of lines) {
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
  return { assessments: found, groups: usedGroups, notes, rules: findRules(ruleLines) };
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

// ---------- Rendering ----------

const $ = id => document.getElementById(id);

function render() {
  renderModuleList();
  const mod = currentModule();
  $("welcome").hidden = !!mod;
  $("moduleView").hidden = !mod;
  if (!mod) return;

  $("moduleName").value = mod.name;
  $("moduleSource").textContent = mod.fileName
    ? `Read from: ${mod.fileName}`
    : "Added manually";
  fillFolderSelect($("moduleFolder"), mod.folderId);
  renderRules(mod);
  $("targetInput").value = mod.target;
  renderTable(mod);
  updateResults();
}

// Notes about how the framework was read, and the pass rules found in it
function renderRules(mod) {
  const notes = mod.notes || [];
  const rules = mod.rules || [];
  const box = $("rulesBox");
  box.hidden = !notes.length && !rules.length;
  box.open = notes.length > 0; // closed unless there's something the student must know
  $("rulesCount").textContent = rules.length ? `(${rules.length})` : "";
  $("rulesList").innerHTML =
    notes.map(n => `<li class="rule-note">${escapeHtml(n)}</li>`).join("") +
    rules.map(r => `<li>${escapeHtml(r)}</li>`).join("");
}

// Folders first (each with its modules), then the modules that aren't in a folder
function renderModuleList() {
  const list = $("moduleList");
  list.innerHTML = "";
  $("noModules").hidden = state.modules.length > 0;
  $("dragHint").hidden = !(state.folders.length && state.modules.length);
  $("uploadFolderPick").hidden = !state.folders.length;
  fillFolderSelect($("uploadFolder"), state.uploadFolderId);

  for (const f of state.folders) list.appendChild(folderItem(f));
  state.modules.filter(m => !m.folderId).forEach(m => list.appendChild(moduleItem(m)));
}

function moduleItem(mod) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = mod.id === state.selectedId ? "active" : "";
  btn.innerHTML = `<span class="m-name"></span><span class="m-mark"></span>`;
  btn.querySelector(".m-name").textContent = mod.name || "Untitled module";
  btn.querySelector(".m-mark").textContent = fmt(calculate(mod).finalSoFar) + "%";
  btn.dataset.id = mod.id;
  btn.draggable = true;
  btn.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/module-id", mod.id);
    e.dataTransfer.effectAllowed = "move";
  });
  btn.addEventListener("click", () => {
    state.selectedId = mod.id;
    saveState();
    render();
  });
  li.appendChild(btn);
  return li;
}

function folderItem(f) {
  const mods = state.modules.filter(m => m.folderId === f.id);
  const li = document.createElement("li");
  li.className = "folder" + (f.collapsed ? " collapsed" : "");
  li.dataset.fid = f.id;
  li.innerHTML = `
    <div class="folder-head">
      <button class="folder-toggle" aria-label="Open or close folder">▾</button>
      <span class="folder-icon">📁</span>
      <input class="folder-name" aria-label="Folder name">
      <span class="folder-count"></span>
      <button class="folder-del" title="Delete folder (keeps its modules)">✕</button>
    </div>
    <ul class="module-list folder-modules"></ul>`;
  const nameIn = li.querySelector(".folder-name");
  nameIn.value = f.name;
  li.querySelector(".folder-count").textContent = mods.length;
  const inner = li.querySelector(".folder-modules");
  if (mods.length) mods.forEach(m => inner.appendChild(moduleItem(m)));
  else inner.innerHTML = `<li class="folder-empty">Empty. Drag modules here.</li>`;

  li.querySelector(".folder-toggle").addEventListener("click", () => {
    f.collapsed = !f.collapsed;
    saveState();
    renderModuleList();
  });
  nameIn.addEventListener("input", () => {
    f.name = nameIn.value;
    saveState();
    fillFolderSelect($("uploadFolder"), state.uploadFolderId);
    const mod = currentModule();
    if (mod) fillFolderSelect($("moduleFolder"), mod.folderId);
  });
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") nameIn.blur(); });
  li.querySelector(".folder-del").addEventListener("click", () => {
    const msg = mods.length
      ? `Delete the folder "${f.name}"? Its ${mods.length} module${mods.length > 1 ? "s" : ""} will stay, just not in a folder.`
      : `Delete the folder "${f.name}"?`;
    if (!confirm(msg)) return;
    mods.forEach(m => (m.folderId = null));
    state.folders = state.folders.filter(x => x.id !== f.id);
    if (state.uploadFolderId === f.id) state.uploadFolderId = null;
    saveState();
    render();
  });

  // Drop a module on the folder to move it in
  li.addEventListener("dragover", e => {
    if (!e.dataTransfer.types.includes("text/module-id")) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", e => { if (!li.contains(e.relatedTarget)) li.classList.remove("drop-target"); });
  li.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove("drop-target");
    moveModule(e.dataTransfer.getData("text/module-id"), f.id);
  });
  return li;
}

function moveModule(moduleId, folderId) {
  const mod = state.modules.find(m => m.id === moduleId);
  if (!mod || mod.folderId === folderId) return;
  mod.folderId = folderId;
  const f = state.folders.find(x => x.id === folderId);
  if (f) f.collapsed = false;
  saveState();
  render();
}

function fillFolderSelect(sel, value) {
  sel.innerHTML = `<option value="">No folder</option>` +
    state.folders.map(f => `<option value="${f.id}">${escapeHtml(f.name || "Unnamed folder")}</option>`).join("");
  sel.value = value || "";
}

// Rows in framework order; a group's rows are shown together under its heading
function renderTable(mod) {
  const body = $("assessBody");
  body.innerHTML = "";
  const shown = new Set();

  const renderGroup = g => {
    shown.add(g.id);
    body.appendChild(groupRow(mod, g));
    mod.assessments.filter(a => a.groupId === g.id).forEach(a => body.appendChild(assessmentRow(mod, a)));
    const addTr = document.createElement("tr");
    addTr.className = "group-add";
    addTr.innerHTML = `<td colspan="6"><button class="link-btn">+ Add to this group</button></td>`;
    addTr.querySelector("button").addEventListener("click", () => addAssessment(mod, g.id));
    body.appendChild(addTr);
  };

  for (const a of mod.assessments) {
    const g = groupOf(mod, a);
    if (!g) body.appendChild(assessmentRow(mod, a));
    else if (!shown.has(g.id)) renderGroup(g);
  }
  mod.groups.filter(g => !shown.has(g.id)).forEach(renderGroup);
}

function groupRow(mod, g) {
  const tr = document.createElement("tr");
  tr.className = "group-row";
  tr.dataset.gid = g.id;
  tr.innerHTML = `
    <td><input type="text" class="in-gname" aria-label="Group name"><span class="sub">Group</span></td>
    <td class="num"><input type="number" class="in-weight in-gweight" min="0" max="100" step="any" aria-label="Group weight"><span class="sub">of final mark</span></td>
    <td colspan="3" class="group-info"></td>
    <td class="center"><button class="del" title="Remove group (keeps its assessments)">✕</button></td>`;
  const nameIn = tr.querySelector(".in-gname");
  const weightIn = tr.querySelector(".in-gweight");
  nameIn.value = g.name;
  weightIn.value = g.weight;
  nameIn.addEventListener("input", () => { g.name = nameIn.value; saveState(); updateResults(); });
  weightIn.addEventListener("input", () => { g.weight = parseFloat(weightIn.value) || 0; saveState(); updateResults(); });
  tr.querySelector(".del").addEventListener("click", () => {
    // Keep the assessments, now counting directly towards the final mark
    mod.assessments.forEach(a => {
      if (a.groupId === g.id) {
        a.weight = Math.round(effectiveWeight(mod, a) * 10000) / 10000;
        a.groupId = null;
      }
    });
    mod.groups = mod.groups.filter(x => x.id !== g.id);
    saveState();
    render();
  });
  return tr;
}

function assessmentRow(mod, a) {
  const g = groupOf(mod, a);
  const tr = document.createElement("tr");
  tr.dataset.id = a.id;
  if (g) tr.classList.add("in-group");
  tr.innerHTML = `
    <td class="name-cell"><input type="text" class="in-name" aria-label="Assessment name"></td>
    <td class="num"><input type="number" class="in-weight in-aweight" min="0" max="100" step="any" aria-label="Weight"><span class="sub">${g ? "of group" : ""}</span></td>
    <td class="num"><input type="text" class="in-mark" inputmode="decimal" placeholder="–" aria-label="Your mark"><span class="mark-pct"></span></td>
    <td class="num contrib"></td>
    <td class="center"><input type="radio" name="finalPick" class="in-final" aria-label="This is the final test"></td>
    <td class="center"><button class="del" title="Remove">✕</button></td>`;

  const nameIn = tr.querySelector(".in-name");
  const weightIn = tr.querySelector(".in-aweight");
  const markIn = tr.querySelector(".in-mark");
  const finalIn = tr.querySelector(".in-final");

  nameIn.value = a.name;
  weightIn.value = a.weight;
  markIn.value = a.mark;
  finalIn.checked = !!a.isFinal;

  // Move an assessment into or out of a group
  if (mod.groups.length) {
    const sel = document.createElement("select");
    sel.className = "in-group-pick";
    sel.setAttribute("aria-label", "Group");
    sel.innerHTML = `<option value="">Not in a group</option>` +
      mod.groups.map(x => `<option value="${x.id}">In: ${escapeHtml(x.name || "Unnamed group")}</option>`).join("");
    sel.value = a.groupId || "";
    sel.addEventListener("change", () => { a.groupId = sel.value || null; saveState(); render(); });
    tr.querySelector(".name-cell").appendChild(sel);
  }

  nameIn.addEventListener("input", () => { a.name = nameIn.value; saveState(); updateResults(); });
  weightIn.addEventListener("input", () => { a.weight = parseFloat(weightIn.value) || 0; saveState(); updateResults(); });
  markIn.addEventListener("input", () => { a.mark = markIn.value; saveState(); updateResults(); });
  finalIn.addEventListener("change", () => {
    mod.assessments.forEach(x => (x.isFinal = x.id === a.id));
    saveState();
    updateResults();
  });
  tr.querySelector(".del").addEventListener("click", () => {
    mod.assessments = mod.assessments.filter(x => x.id !== a.id);
    saveState();
    render();
  });
  return tr;
}

function addAssessment(mod, groupId) {
  const a = { id: uid(), name: "", weight: 0, mark: "", isFinal: !mod.assessments.length, groupId: groupId || null };
  // Put it after the last row of its group so it shows up there
  const lastIdx = groupId ? mod.assessments.map(x => x.groupId).lastIndexOf(groupId) : -1;
  if (lastIdx >= 0) mod.assessments.splice(lastIdx + 1, 0, a);
  else mod.assessments.push(a);
  saveState();
  render();
  const input = document.querySelector(`tr[data-id="${a.id}"] .in-name`);
  if (input) input.focus();
}

// Updates numbers without rebuilding the table, so typing isn't interrupted
function updateResults() {
  const mod = currentModule();
  if (!mod) return;
  const c = calculate(mod);

  // Per-row values
  for (const r of c.rows) {
    const tr = document.querySelector(`tr[data-id="${r.a.id}"]`);
    if (!tr) continue;
    tr.classList.toggle("is-final", !!r.a.isFinal);
    const markIn = tr.querySelector(".in-mark");
    const pctLabel = tr.querySelector(".mark-pct");
    const contrib = tr.querySelector(".contrib");
    markIn.classList.toggle("invalid", Number.isNaN(r.pct));
    const isFraction = String(r.a.mark).includes("/");
    pctLabel.textContent = isFraction && hasMark(r) ? `= ${fmt(r.pct)}%` : "";
    contrib.textContent = hasMark(r)
      ? `${fmt((r.pct * r.weight) / 100, 2)} / ${fmt(r.weight, 2)}`
      : `– / ${fmt(r.weight, 2)}`;
  }

  // Per-group values
  for (const g of mod.groups) {
    const info = document.querySelector(`tr[data-gid="${g.id}"] .group-info`);
    if (!info) continue;
    const s = c.groupStats[g.id];
    info.textContent = s.average === null
      ? "No marks in this group yet"
      : `Group mark so far: ${fmt(s.average)}%`;
  }

  $("totalWeight").textContent = fmt(c.totalWeight, 2) + "%";
  $("totalEarned").textContent = fmt(c.earned, 2);

  // Warnings about weights that don't add up
  const problems = [];
  if (!mod.assessments.length) {
    problems.push("No tests or assignments with weights were found in this file. Add them with \"+ Add assessment\" (and \"+ Add group\" if your module has parts like a class mark).");
  } else {
    for (const g of mod.groups) {
      const label = `"${g.name || "Unnamed group"}"`;
      if (!(Number(g.weight) > 0)) problems.push(`Enter how much ${label} counts towards your final mark.`);
      const inner = c.groupStats[g.id].inner;
      if (Math.abs(inner - 100) > 0.01) problems.push(`The assessments in ${label} add up to ${fmt(inner, 2)}% of the group, not 100%.`);
    }
    if (Math.abs(c.totalWeight - 100) > 0.01) {
      problems.push(`Everything adds up to ${fmt(c.totalWeight, 2)}% of the final mark, not 100%. Check the weights against your module framework. (Results are scaled to 100% for now.)`);
    }
  }
  const warn = $("weightWarning");
  warn.hidden = !problems.length;
  warn.innerHTML = problems.map(p => `<span>${escapeHtml(p)}</span>`).join("");

  // Stats
  $("statFinal").textContent = fmt(c.finalSoFar) + "%";
  $("statFinalSub").textContent = "earned out of 100%";
  $("statAvg").textContent = c.average === null ? "–" : fmt(c.average) + "%";
  $("statAvgSub").textContent = c.average === null ? "No marks yet" : "on the work you've done";
  $("statDone").textContent = fmt(c.donePct) + "%";
  $("progressBar").style.width = Math.min(100, c.donePct) + "%";

  // Chips
  document.querySelectorAll(".chip").forEach(ch =>
    ch.classList.toggle("active", Number(ch.dataset.target) === Number(mod.target)));

  renderNeeded(mod, c);

  // Keep sidebar mark in sync
  const sideBtn = document.querySelector(`.module-list button[data-id="${mod.id}"]`);
  if (sideBtn) {
    sideBtn.querySelector(".m-mark").textContent = fmt(c.finalSoFar) + "%";
    sideBtn.querySelector(".m-name").textContent = mod.name || "Untitled module";
  }
}

function renderNeeded(mod, c) {
  const box = $("neededResult");
  const target = Number(mod.target) || 0;
  box.className = "needed-result";

  if (!c.finalRow) {
    box.classList.add("info");
    box.innerHTML = `<p>Choose your last test of the semester in the <b>Final test</b> column.</p>`;
    return;
  }
  const finalName = escapeHtml(c.finalRow.a.name || "the final test");

  // Final test already written: show the result
  if (hasMark(c.finalRow) && !c.missing.length) {
    const ok = c.finalSoFar >= target;
    box.classList.add(ok ? "good" : "bad");
    box.innerHTML = `<p>Your final mark for this module</p>
      <span class="big">${fmt(c.finalSoFar)}%</span>
      <p>${ok ? `🎉 You reached your goal of ${target}%.` : `This is below your goal of ${target}%.`}</p>`;
    return;
  }

  if (c.missing.length) {
    box.classList.add("info");
    const names = c.missing.map(r => escapeHtml(r.a.name || "Unnamed")).join(", ");
    box.innerHTML = `<p>Enter your marks for <b>${names}</b> and you'll see the mark you need in <b>${finalName}</b> here.</p>`;
    return;
  }

  const n = c.needed;
  if (n <= 0) {
    box.classList.add("good");
    box.innerHTML = `<p>You need in ${finalName}</p>
      <span class="big">0%</span>
      <p>🎉 You already have enough for ${target}%. (Check if your module has a sub-minimum for ${finalName}.)</p>`;
  } else if (n > 100) {
    box.classList.add("bad");
    const best = c.finalSoFar + (c.finalRow.weight * (100 / c.totalWeight));
    box.innerHTML = `<p>You would need in ${finalName}</p>
      <span class="big">${fmt(n)}%</span>
      <p>That's more than 100%, so ${target}% isn't reachable. The highest final mark you can still get is ${fmt(best)}%.</p>`;
  } else {
    box.classList.add(n > 75 ? "bad" : "good");
    box.innerHTML = `<p>To finish with ${target}%, you need in ${finalName}</p>
      <span class="big">${fmt(n)}%</span>
      <p>${finalName} counts ${fmt(c.finalRow.weight, 2)}% of your final mark.</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- Actions ----------

async function handleFiles(files) {
  const status = $("uploadStatus");
  let added = 0;
  for (const file of files) {
    status.textContent = `Reading ${file.name}…`;
    try {
      const text = await extractText(file);
      const parsed = parseFramework(text);
      const mod = {
        id: uid(),
        name: guessModuleName(text, file.name),
        fileName: file.name,
        target: 50,
        folderId: state.uploadFolderId || null,
        groups: parsed.groups,
        assessments: parsed.assessments,
        notes: parsed.notes,
        rules: parsed.rules,
      };
      state.modules.push(mod);
      state.selectedId = mod.id;
      added++;
    } catch (err) {
      console.error(err);
      status.textContent = `Could not read ${file.name}: ${err.message}`;
      saveState();
      render();
      return;
    }
  }
  status.textContent = added ? `Added ${added} module${added > 1 ? "s" : ""}. Check the weights below.` : "";
  saveState();
  render();
}

$("fileInput").addEventListener("change", e => {
  handleFiles([...e.target.files]);
  e.target.value = "";
});

const dz = $("dropZone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("dragover"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("dragover"); }));
dz.addEventListener("drop", e => handleFiles([...e.dataTransfer.files]));

$("addManualBtn").addEventListener("click", () => {
  const mod = {
    id: uid(),
    name: "New module",
    fileName: "",
    target: 50,
    folderId: state.uploadFolderId || null,
    groups: [],
    assessments: [
      { id: uid(), name: "Test 1", weight: 25, mark: "", isFinal: false, groupId: null },
      { id: uid(), name: "Assignment 1", weight: 25, mark: "", isFinal: false, groupId: null },
      { id: uid(), name: "A2 (final test)", weight: 50, mark: "", isFinal: true, groupId: null },
    ],
  };
  state.modules.push(mod);
  state.selectedId = mod.id;
  saveState();
  render();
  $("moduleName").select();
});

$("addRowBtn").addEventListener("click", () => addAssessment(currentModule(), null));

// Folders
$("addFolderBtn").addEventListener("click", () => {
  const f = { id: uid(), name: `Semester ${state.folders.length + 1}`, collapsed: false };
  state.folders.push(f);
  saveState();
  render();
  const input = document.querySelector(`.folder[data-fid="${f.id}"] .folder-name`);
  if (input) { input.focus(); input.select(); }
});

$("uploadFolder").addEventListener("change", e => {
  state.uploadFolderId = e.target.value || null;
  saveState();
});

$("moduleFolder").addEventListener("change", e => moveModule(currentModule().id, e.target.value || null));

// Dropping a module on the list itself (not on a folder) takes it out of its folder
const moduleListEl = $("moduleList");
moduleListEl.addEventListener("dragover", e => {
  if (e.dataTransfer.types.includes("text/module-id")) e.preventDefault();
});
moduleListEl.addEventListener("drop", e => {
  const id = e.dataTransfer.getData("text/module-id");
  if (!id) return;
  e.preventDefault();
  moveModule(id, null);
});

$("addGroupBtn").addEventListener("click", () => {
  const mod = currentModule();
  const g = { id: uid(), name: "Class mark", weight: 0 };
  mod.groups.push(g);
  saveState();
  render();
  const input = document.querySelector(`tr[data-gid="${g.id}"] .in-gname`);
  if (input) input.select();
});

$("moduleName").addEventListener("input", e => {
  currentModule().name = e.target.value;
  saveState();
  updateResults();
});

$("deleteModuleBtn").addEventListener("click", () => {
  const mod = currentModule();
  if (!confirm(`Delete "${mod.name}" and all its marks?`)) return;
  state.modules = state.modules.filter(m => m.id !== mod.id);
  state.selectedId = state.modules.length ? state.modules[state.modules.length - 1].id : null;
  saveState();
  render();
});

$("targetInput").addEventListener("input", e => {
  currentModule().target = parseFloat(e.target.value) || 0;
  saveState();
  updateResults();
});

document.querySelectorAll(".chip").forEach(ch => ch.addEventListener("click", () => {
  currentModule().target = Number(ch.dataset.target);
  $("targetInput").value = ch.dataset.target;
  saveState();
  updateResults();
}));

// Backup / restore (marks are stored per browser, so this moves them between devices)
$("exportBtn").addEventListener("click", () => {
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
    saveState();
    render();
  } catch (err) {
    alert("Could not restore: " + err.message);
  }
});

render();
