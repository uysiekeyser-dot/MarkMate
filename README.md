# Mark Calculator

A website where students upload their module frameworks and get a mark calculator for every module.

- The first time, a short intro shows how it works. Then tap **+** on **My modules** to add a module: **Upload** its framework (PDF, Word `.docx` or `.txt`, several at once) or **Paste text** from it. With the AI reader on you can also **Take a photo** of the page.
- **Reading framework:** the framework is shown line by line, and the lines the reader used are marked (`15%`, `Group`, `Formula`, `Rule`). Then **Check the weights**: fix names and weights, pick the final test, add a sub-minimum, add assessments or groups. **Save module** is ready once everything adds up to 100% (or tap **Save anyway** if your framework really adds up differently).
- **My modules** shows your average on work done, how many modules are on track and your next date. Each module shows its **final mark so far**, a bar with your goal marked, its next key date and what you need (for example "Need 47% in A2").
- Tap a module to open it, and **← My modules** to go back. Folders close again when you go back, so the list stays clean.
- **On a module's page:** your final mark so far, average and weight completed; **Final mark I want** (Pass 50, 60, Dist. 75 or your own number) with the mark you need; and the assessments. Tap an assessment to enter a mark (as `68` or `34/50`). Turn on **What-if** to try marks for the tests still to come. Tap the pencil to edit the name and weights.
- **Key dates:** the dates of tests, exams and due dates are read from each framework. The **Key dates** tab lists every module's coming dates; fix or add dates at the bottom of a module's page.
- Sort modules into folders (e.g. "Semester 1", "Semester 2"): tap **New folder**, open a folder and tap the pencil to rename it. Drag folders and modules by their grip handle to put them in your own order (works with a finger too); drop a module on a folder to move it there, or tap the folder tag at the top of a module's page. Choose **Save to folder** before adding to put new modules straight into a folder.
- **Add to your calendar:** **To calendar** on a module's Key dates (or **Add all to my calendar** on the Key dates tab) adds the coming dates to your phone's calendar as all-day events with a reminder at 09:00 the day before.
- **Share with classmates:** the share button on a module's page makes a link and QR code with the module's weights, groups, sub-minimums, rules and key dates (never your marks). A classmate opens it, checks the weights and saves the module, with no uploading.
- **Credits:** add a module's credits on **Check the weights** (the pencil on its page). Once every module with marks has credits, the average on My modules and in each folder is weighted by credits.
- **Progress:** each module's page has a chart of your final mark so far and your average on work done after each mark, with your goal as a dashed line. Tap or point at it to read the numbers.
- The **⋯** menu on My modules has the AI reader, Install app, Backup, Restore and Auto / Light / Dark appearance.
- Everything is saved automatically in your browser. Use **Backup** / **Restore** to move your marks to another device or browser.

Nothing is uploaded to a server: the files are read inside your browser (unless you turn on the AI reader, below).

## AI reader (optional, free)

The built-in reader handles common framework layouts. For frameworks it gets wrong, turn on the **AI reader**, which sends the framework text to Google's Gemini AI to work out the assessments, weights, groups, final test, replacement assessments (like A3) and pass rules.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey), sign in with a Google account and click **Create API key**.
2. On the site, tap **⋯** on My modules, then **AI reader**. Paste the key, tap **Test key** and then **Save**.
3. Add frameworks as usual. For modules you added before, open the module and tap the sparkle button (**Read again with AI**; your marks are kept).

PDF frameworks are sent to the AI as the PDF itself, so it sees the pages (tables, columns, footnotes, even scanned pages) and not just the text; Word files are sent as text, and photos as the photo. Uploaded PDFs are kept in the browser so **Read again with AI** can send them again. If the AI's weights don't add up, it's asked once more to fix them, and if they still don't, the built-in reader's weights are used.

Each student uses their own key. It's saved only in their own browser and is not included in Backup. The free tier has a daily limit; when it's used up, or if the AI fails, the built-in reader is used instead. On the free tier Google may use the text you send to improve its products, so don't upload anything private. Always check the weights the AI found against your framework.

## Phone app

The site can be installed on a phone like an app (an installable web app). It then opens from the home screen, full screen, and works without internet for entering marks and checking key dates. Uploading frameworks and the AI reader still need internet.

- **Android (Chrome):** tap **⋯** on My modules, then **Install app** (or the browser menu → **Install app** / **Add to Home screen**).
- **iPhone / iPad (Safari):** tap **Share** → **Add to Home Screen** → **Add**. **Install app** in the ⋯ menu shows these steps.

On iPhone the installed app keeps its own copy of your data, separate from Safari. Use **Backup** in Safari and **Restore** in the app to bring your modules across. The app updates itself when you upload new files to GitHub.

## Files

| File | What it does |
|------|--------------|
| `index.html` | The page layout |
| `style.css` | The look of the site (the "Industry" design: colours, fonts, light and dark mode) |
| `app.js` | Reads the frameworks, does the calculations, saves the marks |
| `manifest.webmanifest` | Makes the site installable as a phone app (name, icon, colours) |
| `sw.js` | Lets the app open without internet |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | The app icons |
| `sample-framework.txt` | An example framework to try the site with |

## Putting it on GitHub Pages

1. Create a new repository on GitHub (for example `mark-calculator`), set it to **Public**.
2. Click **Add file → Upload files** and upload all the files above (and `README.md`). Click **Commit changes**.
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the `main` branch and the `/ (root)` folder, and click **Save**.
5. After a minute or two your site is live at `https://<your-username>.github.io/mark-calculator/`.

## Tips

- Always check the weights after uploading. Frameworks are written in many different ways, so the site may miss a row or pick up one too many. On **Check the weights** (or the pencil on a module) you can edit names and weights, remove rows (×) or add rows.
- The weights should add up to 100%. The site warns you if they don't.
- **Groups:** some modules have parts with their own tests inside, e.g. "Class mark 40% = Test 1 40% + Test 2 40% + Tutorials 20%" and "Exam 60%". On **Check the weights**, tap **Add group**, name it "Class mark", set it to 40 (% of final mark), and add its tests with weights as a % of the group. The site reads groups automatically when the framework has tables per group with a "Total 100%" line plus formulas like "Final module mark = 40% class mark + 60% theory exam mark".
- Pick which test is the last test of the semester in the **Final** column on **Check the weights**.
- Scanned PDFs (photos of pages) have no readable text for the built-in reader. Turn on the AI reader (it reads the PDF pages), or add those modules with **Add a module by hand instead**.
