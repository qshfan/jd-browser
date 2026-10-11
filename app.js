// Read-only job browser over the Supabase Data API (schema `api`).
//   GET /rpc/search_jobs?q=…   jobs, best match first (newest first without q)
//   GET /jobs?source_job_id=…  one job with its description
//   GET /searches              the searches to filter by
// Filters and the open job live in the URL, so a link shows the same view.

"use strict";

const { supabaseUrl, publishableKey, pageSize } = window.JD_CONFIG;
const API = `${supabaseUrl}/rest/v1`;
const LIST_FIELDS = "source,source_job_id,title,company,location,posted_at,first_seen_at,priority";

const form = document.getElementById("filters");
const list = document.getElementById("list");
const count = document.getElementById("count");
const more = document.getElementById("more");
const reader = document.getElementById("reader");

let offset = 0;
let request = 0; // ignore responses to superseded requests
let selected = null;

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get(path, params, { exactCount = false } = {}) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of params) url.searchParams.append(key, value);
  const headers = { apikey: publishableKey, "Accept-Profile": "api" };
  if (exactCount) headers.Prefer = "count=exact";
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.message || response.statusText, body.code);
  }
  const total = Number((response.headers.get("Content-Range") || "").split("/")[1]);
  return { rows: await response.json(), total: Number.isFinite(total) ? total : null };
}

// -- filters <-> URL ------------------------------------------------------------

function filters() {
  const data = new FormData(form);
  return {
    q: (data.get("q") || "").trim(),
    search: data.get("search") || "",
    posted: data.get("posted") || "",
    seniority: data.get("seniority") || "",
    priority: data.get("priority") === "1",
  };
}

function writeUrl() {
  const f = filters();
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.search) params.set("search", f.search);
  if (f.posted) params.set("posted", f.posted);
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
  form.posted.value = params.get("posted") || "";
  form.seniority.value = params.get("seniority") || "";
  form.priority.checked = params.get("priority") === "1";
  return params.get("job");
}

function queryParams(f) {
  const params = [["q", f.q], ["select", LIST_FIELDS], ["limit", pageSize], ["offset", offset]];
  if (f.search) params.push(["search_names", `cs.{${JSON.stringify(f.search)}}`]);
  if (f.posted) params.push(["posted_at", `gte.${daysAgo(Number(f.posted))}`]);
  if (f.seniority) params.push(["seniority_level", `eq.${f.seniority}`]);
  if (f.priority) params.push(["priority", "is.true"]);
  return params;
}

// -- list ---------------------------------------------------------------------------

async function loadJobs({ append = false } = {}) {
  const mine = ++request;
  if (!append) offset = 0;
  more.hidden = true;
  if (!append) count.textContent = "Loading jobs…";

  try {
    const { rows, total } = await get("rpc/search_jobs", queryParams(filters()), { exactCount: true });
    if (mine !== request) return;
    if (!append) list.replaceChildren();
    rows.forEach((job) => list.append(jobItem(job)));
    offset += rows.length;
    count.textContent = countText(total ?? offset);
    more.hidden = total === null || offset >= total;
  } catch (error) {
    if (mine !== request) return;
    list.replaceChildren();
    count.textContent = "";
    list.append(notice(error));
  }
}

function countText(total) {
  if (total === 0) return "No jobs match these filters. Try a shorter search or fewer filters.";
  return total === 1 ? "1 job" : `${total} jobs`;
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
    const { rows } = await get("jobs", [["source_job_id", `eq.${id}`], ["select", "*"], ["limit", 1]]);
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

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function relativeDay(isoDate) {
  if (!isoDate) return "on an unknown date";
  const today = new Date(new Date().toISOString().slice(0, 10));
  const days = Math.round((today - new Date(isoDate.slice(0, 10))) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${formatDate(isoDate)}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// -- start ----------------------------------------------------------------------------

async function loadSearches() {
  try {
    const { rows } = await get("searches", [["select", "search_name,jobs"]]);
    for (const { search_name, jobs } of rows) {
      const option = document.createElement("option");
      option.value = search_name;
      option.textContent = `${search_name} (${jobs})`;
      form.search.append(option);
    }
    form.search.value = form.search.dataset.wanted || "";
  } catch {
    // The list request reports the problem; the filter just stays at "All searches".
  }
}

let typing;
form.q.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { writeUrl(); loadJobs(); }, 300);
});
form.addEventListener("change", (event) => {
  if (event.target === form.q) return;
  writeUrl();
  loadJobs();
});
form.addEventListener("submit", (event) => event.preventDefault());
more.addEventListener("click", () => loadJobs({ append: true }));

const initialJob = readUrl();
loadSearches().then(() => {
  loadJobs();
  if (initialJob) openJob(initialJob);
});
