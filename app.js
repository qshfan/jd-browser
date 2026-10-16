// Read-only job browser over the Supabase Data API (schema `api`).
//   GET /jobs?select=<list fields>       recent jobs, once, when the page opens
//   GET /rpc/search_jobs?q=…&select=id   ids matching a text search, best first
//   GET /jobs?source_job_id=…            one job with its description
//   GET /priority_companies              the companies "Priority" means, for "Which?"
// The jobs change once a day, so the list is loaded once and the search,
// posted, seniority and priority filters run in the browser: no request, no
// wait. Only the text search goes to the database, and its answers are cached.
// Only jobs posted in the last RECENT_DAYS are loaded: older ones are mostly
// filled, and the cut-off keeps the download the same size as the table grows.
// Filters and the open job live in the URL, so a link shows the same view.

"use strict";

const { supabaseUrl, publishableKey, pageSize } = window.JD_CONFIG;
const API = `${supabaseUrl}/rest/v1`;
const LIST_FIELDS =
  "source,source_job_id,title,company,location,posted_at,first_seen_at,priority,seniority_level,search_names";
const API_PAGE = 1000; // the Data API returns at most 1000 rows per request
const RECENT_DAYS = 60;
const cutoff = localDate(-RECENT_DAYS);
// Posted since the cut-off, or (no posting date) first seen since then.
const RECENT = ["or", `(posted_at.gte.${cutoff},and(posted_at.is.null,first_seen_at.gte.${cutoff}))`];

const form = document.getElementById("filters");
const list = document.getElementById("list");
const count = document.getElementById("count");
const more = document.getElementById("more");
const reader = document.getElementById("reader");
const clearDates = document.getElementById("clear-dates");

let jobs = null;          // every job, newest first; null until loaded
const matches = new Map(); // text query -> Promise of source_job_ids, best match first
let shown = [];           // jobs passing the current filters, in display order
let rendered = 0;         // how many of `shown` are in the list
let request = 0;          // ignore text-search answers to superseded queries
let selected = null;

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of params) url.searchParams.append(key, value);
  const response = await fetch(url, { headers: { apikey: publishableKey, "Accept-Profile": "api" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.message || response.statusText, body.code);
  }
  return response.json();
}

// -- data -------------------------------------------------------------------------

async function loadAllJobs() {
  const rows = [];
  for (;;) {
    const page = await get("jobs", [
      ["select", LIST_FIELDS],
      RECENT,
      ["order", "first_seen_at.desc,posted_at.desc.nullslast,source_job_id.desc"],
      ["limit", API_PAGE],
      ["offset", rows.length],
    ]);
    rows.push(...page);
    if (page.length < API_PAGE) return rows;
  }
}

function textMatches(q) {
  if (!matches.has(q)) {
    const ids = get("rpc/search_jobs", [["q", q], ["select", "source_job_id"], RECENT])
      .then((rows) => rows.map((row) => row.source_job_id));
    ids.catch(() => matches.delete(q)); // let a failed search be retried
    matches.set(q, ids);
  }
  return matches.get(q);
}

// -- filters <-> URL ------------------------------------------------------------

function filters() {
  const data = new FormData(form);
  return {
    q: (data.get("q") || "").trim(),
    search: data.get("search") || "",
    from: data.get("from") || "",
    to: data.get("to") || "",
    seniority: data.get("seniority") || "",
    priority: data.get("priority") === "1",
  };
}

function writeUrl() {
  const f = filters();
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.search) params.set("search", f.search);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.seniority) params.set("seniority", f.seniority);
  if (f.priority) params.set("priority", "1");
  if (selected) params.set("job", selected);
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  form.q.value = params.get("q") || "";
  form.search.dataset.wanted = params.get("search") || "";
  form.from.value = params.get("from") || "";
  form.to.value = params.get("to") || "";
  // Links from before the date picker: ?posted=7 meant "the last 7 days".
  if (params.has("posted") && !params.has("from")) form.from.value = localDate(-Number(params.get("posted")));
  form.seniority.value = params.get("seniority") || "";
  form.priority.checked = params.get("priority") === "1";
  syncDates();
  return params.get("job");
}

// One date picked = that day; the other end follows until it is set too, and
// the two ends never cross.
function syncDates(changed) {
  const { from, to } = form;
  if (changed === from && from.value && (!to.value || to.value < from.value)) to.value = from.value;
  if (changed === to && to.value && (!from.value || from.value > to.value)) from.value = to.value;
  clearDates.hidden = !from.value && !to.value;
}

function passes(job, f) {
  if (f.search && !job.search_names.includes(f.search)) return false;
  if (f.from && !(job.posted_at && job.posted_at >= f.from)) return false;
  if (f.to && !(job.posted_at && job.posted_at <= f.to)) return false;
  if (f.seniority && job.seniority_level !== f.seniority) return false;
  if (f.priority && !job.priority) return false;
  return true;
}

// -- list ---------------------------------------------------------------------------

async function showJobs() {
  if (!jobs) return;
  const mine = ++request;
  const f = filters();
  let ordered = jobs;
  if (f.q) {
    count.textContent = "Searching…";
    try {
      const ids = await textMatches(f.q);
      if (mine !== request) return;
      const byId = new Map(jobs.map((job) => [job.source_job_id, job]));
      ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    } catch (error) {
      if (mine !== request) return;
      showError(error);
      return;
    }
  }
  shown = ordered.filter((job) => passes(job, f));
  rendered = 0;
  list.replaceChildren();
  count.textContent = countText(shown.length, !f.from && !f.to);
  renderMore();
}

function renderMore() {
  const next = shown.slice(rendered, rendered + pageSize);
  list.append(...next.map(jobItem));
  rendered += next.length;
  more.hidden = rendered >= shown.length;
}

function showError(error) {
  list.replaceChildren(notice(error));
  count.textContent = "";
  more.hidden = true;
}

function countText(total, anyDate) {
  if (total === 0) return "No jobs match these filters. Try a shorter search or fewer filters.";
  const jobs = total === 1 ? "1 job" : `${total} jobs`;
  return anyDate ? `${jobs} posted in the last ${RECENT_DAYS} days` : jobs;
}

function jobItem(job) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = job.priority ? "job job--priority" : "job";
  button.dataset.id = job.source_job_id;
  button.setAttribute("aria-current", String(job.source_job_id === selected));
  button.append(
    span("job__title", job.title),
    span("job__where", [job.company, job.location].filter(Boolean).join(", ")),
    span("job__when", `Posted ${relativeDay(job.posted_at)}${job.priority ? ", priority company" : ""}`),
  );
  button.addEventListener("click", () => openJob(job.source_job_id));
  item.append(button);
  return item;
}

function notice(error) {
  const box = document.createElement("li");
  box.className = "notice";
  const title = document.createElement("strong");
  if (error.code === "PGRST106") {
    title.textContent = "The job data isn't published yet.";
    box.append(title, document.createElement("br"),
      "In Supabase, add the schema “api” under Settings, Data API, Exposed schemas.");
  } else {
    title.textContent = "Couldn't load jobs.";
    box.append(title, document.createElement("br"),
      `${error.message || "Network error"}. Check your connection and reload the page.`);
  }
  return box;
}

// -- reader -------------------------------------------------------------------------

async function openJob(id) {
  selected = id;
  writeUrl();
  for (const button of list.querySelectorAll(".job")) {
    button.setAttribute("aria-current", String(button.dataset.id === id));
  }
  reader.classList.add("reader--open");
  reader.replaceChildren(span("reader__loading", "Loading the job…"));

  try {
    const rows = await get("jobs", [["source_job_id", `eq.${id}`], ["select", "*"], ["limit", 1]]);
    if (selected !== id) return;
    reader.replaceChildren(...(rows[0] ? jobView(rows[0]) : [span("", "This job is no longer in the database.")]));
    reader.scrollTop = 0;
  } catch (error) {
    if (selected === id) reader.replaceChildren(span("", `Couldn't load this job: ${error.message}.`));
  }
}

function jobView(job) {
  const back = document.createElement("button");
  back.type = "button";
  back.className = "reader__back";
  back.textContent = "Back to the list";
  back.addEventListener("click", () => reader.classList.remove("reader--open"));

  const title = document.createElement("h2");
  title.className = "reader__title";
  title.textContent = job.title;

  const company = document.createElement("p");
  company.className = "reader__company";
  if (job.company_url) {
    const link = externalLink(job.company_url, job.company || "Company page");
    company.append(link);
  } else {
    company.textContent = job.company || "";
  }

  const facts = document.createElement("dl");
  facts.className = "facts";
  const rows = [
    ["Location", job.location],
    ["Seniority", job.seniority_level],
    ["Contract", job.employment_type],
    ["Function", job.job_function],
    ["Industry", job.industries],
    ["Work type", job.work_type],
    ["Posted", job.posted_at && `${formatDate(job.posted_at)} (${relativeDay(job.posted_at)})`],
    ["First seen", job.first_seen_at && formatDate(job.first_seen_at)],
    ["Found by", (job.search_names || []).join(", ")],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    facts.append(dt, dd);
  }
  if (job.priority) {
    const dt = document.createElement("dt");
    dt.textContent = "Priority";
    const dd = document.createElement("dd");
    dd.className = "priority-note";
    dd.textContent = "On your priority company list";
    facts.append(dt, dd);
  }

  const actions = document.createElement("p");
  actions.className = "reader__actions";
  const open = externalLink(job.url, "Open on LinkedIn");
  open.className = "button";
  actions.append(open);

  const description = document.createElement("div");
  description.className = "description";
  if (job.description) {
    description.innerHTML = DOMPurify.sanitize(marked.parse(job.description), { USE_PROFILES: { html: true } });
    for (const link of description.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  } else {
    description.textContent = "LinkedIn didn't return a description for this job. Open it on LinkedIn to read it.";
  }

  // Facts come first in the DOM (read first on small screens); on wide screens
  // the stylesheet moves them into a column beside the description.
  const head = document.createElement("header");
  head.className = "reader__head";
  head.append(title, company, actions);
  const body = document.createElement("div");
  body.className = "reader__body";
  facts.classList.add("reader__facts");
  body.append(facts, description);

  return [back, head, body];
}

// -- helpers ------------------------------------------------------------------------

function span(className, text) {
  const element = document.createElement("span");
  if (className) element.className = className;
  element.textContent = text ?? "";
  return element;
}

function externalLink(href, text) {
  const link = document.createElement("a");
  link.href = /^https?:\/\//.test(href) ? href : "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  return link;
}

// YYYY-MM-DD in the viewer's time zone, `offset` days from today.
function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function relativeDay(isoDate) {
  if (!isoDate) return "on an unknown date";
  const days = Math.round((new Date(localDate()) - new Date(isoDate.slice(0, 10))) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${formatDate(isoDate)}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// -- start ----------------------------------------------------------------------------

function fillSearches() {
  const counts = new Map();
  for (const job of jobs) {
    for (const name of job.search_names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const name of [...counts.keys()].sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name} (${counts.get(name)})`;
    form.search.append(option);
  }
  form.search.value = form.search.dataset.wanted || "";
}

// Same matching as the database: the company name, ignoring case.
function fillPriorityCompanies(companies) {
  const counts = new Map();
  for (const job of jobs) {
    if (job.priority) counts.set(job.company.toLowerCase(), (counts.get(job.company.toLowerCase()) || 0) + 1);
  }
  const items = document.getElementById("priority-companies");
  for (const { company } of companies) {
    const n = counts.get(company.toLowerCase()) || 0;
    const item = document.createElement("li");
    item.append(span("", company), span("priority-list__count", n === 1 ? "1 job" : `${n} jobs`));
    items.append(item);
  }
  document.getElementById("priority-note").textContent = companies.length
    ? `Jobs posted in the last ${RECENT_DAYS} days. To change the list, edit the table jd.priority_companies in Supabase.`
    : "No priority companies yet. Add them to the table jd.priority_companies in Supabase.";
  document.getElementById("which").hidden = false;
}

function limitDates() {
  const posted = jobs.map((job) => job.posted_at).filter(Boolean).sort();
  for (const input of [form.from, form.to]) {
    input.min = posted[0] || cutoff;
    input.max = localDate();
  }
}

let typing;
form.q.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { writeUrl(); showJobs(); }, 250);
});
form.addEventListener("change", (event) => {
  if (event.target === form.q) return;
  syncDates(event.target);
  writeUrl();
  showJobs();
});
clearDates.addEventListener("click", () => {
  form.from.value = "";
  form.to.value = "";
  syncDates();
  writeUrl();
  showJobs();
});
form.addEventListener("submit", (event) => event.preventDefault());
more.addEventListener("click", renderMore);

const initialJob = readUrl();
if (initialJob) openJob(initialJob);
count.textContent = "Loading jobs…";
const priorityCompanies = get("priority_companies", [["select", "company"]]);
priorityCompanies.catch(() => {}); // handled below, once the jobs are in
loadAllJobs().then(
  (rows) => {
    jobs = rows;
    fillSearches();
    limitDates();
    showJobs();
    // Without the list, "Which?" just stays hidden.
    priorityCompanies.then(fillPriorityCompanies, () => {});
  },
  showError,
);
