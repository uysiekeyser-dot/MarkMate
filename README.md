# Mark Calculator

A website where students upload their module frameworks and get a mark calculator for every module.

- Upload a module framework (PDF, Word `.docx` or `.txt`). The site finds every test and assignment and its weight.
- Add as many modules as you like. Each module keeps its own marks.
- Sort modules into folders (e.g. "Semester 1", "Semester 2"): click **+ New folder**, click a folder's name to rename it, and drag modules onto it or pick the folder at the top of a module's page. Choose **Save to folder** before uploading to put new modules straight into a folder.
- Enter a mark (as `68` or `34/50`) and your final mark updates immediately.
- When every mark except the final test (e.g. A2) is entered, the bottom of the page shows the percentage you need in that test to reach your goal (50% by default).
- Everything is saved automatically in your browser. Use **Backup** / **Restore** to move your marks to another device or browser.

Nothing is uploaded to a server: the files are read inside your browser (unless you turn on the AI reader, below).

## AI reader (optional, free)

The built-in reader handles common framework layouts. For frameworks it gets wrong, turn on the **AI reader**, which sends the framework text to Google's Gemini AI to work out the assessments, weights, groups, final test, replacement assessments (like A3) and pass rules.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey), sign in with a Google account and click **Create API key**.
2. On the site, click **🤖 AI reader**, paste the key, click **Test key** and then **Save**.
3. Upload frameworks as usual. For modules you uploaded before, open the module and click **🤖 Read again with AI** (your marks are kept).

Each student uses their own key. It's saved only in their own browser and is not included in Backup. The free tier has a daily limit; when it's used up, or if the AI fails, the built-in reader is used instead. On the free tier Google may use the text you send to improve its products, so don't upload anything private. Always check the weights the AI found against your framework.

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
