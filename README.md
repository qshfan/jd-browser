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

- The page reads `api.search_jobs`, `api.jobs` and `api.searches`, defined in
  jd_hub's `db/migrations/002_search_and_api.sql` and `003_api_searches.sql`.
  If those views change, update `app.js` to match.
- `api` must be listed under Supabase > Settings > Data API > Exposed schemas.
- Filters and the open job are kept in the URL, so a copied link shows the same view.
