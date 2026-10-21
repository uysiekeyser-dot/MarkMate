# Mark Calculator

A website where students upload their module frameworks and get a mark calculator for every module.

- Upload a module framework (PDF, Word `.docx` or `.txt`). The site finds every test and assignment and its weight.
- Add as many modules as you like. Each module keeps its own marks.
- Sort modules into folders (e.g. "Semester 1", "Semester 2"): click **+ New folder**, click a folder's name to rename it, and drag modules onto it or pick the folder at the top of a module's page. Choose **Save to folder** before uploading to put new modules straight into a folder.
- Enter a mark (as `68` or `34/50`) and your final mark updates immediately.
- When every mark except the final test (e.g. A2) is entered, the bottom of the page shows the percentage you need in that test to reach your goal (50% by default).
- Everything is saved automatically in your browser. Use **Backup** / **Restore** to move your marks to another device or browser.

Nothing is uploaded to a server: the files are read inside your browser.

## Files

| File | What it does |
|------|--------------|
| `index.html` | The page layout |
| `style.css` | The look of the site (light and dark mode) |
| `app.js` | Reads the frameworks, does the calculations, saves the marks |
| `sample-framework.txt` | An example framework to try the site with |

## Putting it on GitHub Pages

1. Create a new repository on GitHub (for example `mark-calculator`), set it to **Public**.
2. Click **Add file → Upload files** and upload `index.html`, `style.css`, `app.js`, `README.md` and `sample-framework.txt`. Click **Commit changes**.
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the `main` branch and the `/ (root)` folder, and click **Save**.
5. After a minute or two your site is live at `https://<your-username>.github.io/mark-calculator/`.

## Tips

- Always check the weights after uploading. Frameworks are written in many different ways, so the site may miss a row or pick up one too many. You can edit names and weights, remove rows (✕) or add rows.
- The weights should add up to 100%. The site warns you if they don't.
- **Groups:** some modules have parts with their own tests inside, e.g. "Class mark 40% = Test 1 40% + Test 2 40% + Tutorials 20%" and "Exam 60%". Click **+ Add group**, name it "Class mark", set it to 40 (% of final mark), and add its tests with weights as a % of the group. The site reads groups automatically when the framework has tables per group with a "Total 100%" line plus formulas like "Final module mark = 40% class mark + 60% theory exam mark".
- Pick which test is the last test of the semester in the **Final test** column.
- Scanned PDFs (photos of pages) have no readable text. Add those modules with **+ Add module manually**.
