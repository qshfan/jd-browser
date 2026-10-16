# jd-browser

A read-only page for browsing the job postings that
[jd_hub](https://github.com/qshfan/jd_hub) collects from LinkedIn. It is static
HTML, CSS and JavaScript that reads the Supabase Data API from the browser: no
build step, no server code.

Live: https://qshfan.github.io/jd-browser/

## Run locally

```bash
cp config.example.js config.js   # then fill in the project URL and publishable key
python3 -m http.server 8765
# open http://127.0.0.1:8765/
```

## Deploy

Every push to `main` publishes the site to GitHub Pages
(`.github/workflows/pages.yml`). The workflow writes `config.js` from two
repository secrets, so neither value is in git:

- `SUPABASE_URL`, e.g. `https://<project-ref>.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY`, the project's publishable key

The publishable key still reaches every visitor's browser; that is how the page
talks to Supabase. What protects the data is the database: the `anon` role can
only read the `api` schema.

## Data

- The page reads `api.jobs` and `api.search_jobs`, defined in jd_hub's
  `db/migrations/002_search_and_api.sql`. If those change, update `app.js` to match.
- The job list (without descriptions) is loaded once when the page opens. The
  search, posted, seniority and priority filters then run in the browser, so
  they apply instantly. Only the text search asks the database, once per
  distinct query. A description loads when its job is opened.
- Only jobs posted in the last 60 days are loaded (`RECENT_DAYS` in `app.js`).
  Older jobs stay in the database but don't appear on the page. The cut-off
  keeps the first download at about 100 KB however large the table grows.
- `api` must be listed under Supabase > Settings > Data API > Exposed schemas.
- Filters and the open job are kept in the URL, so a copied link shows the same view.
