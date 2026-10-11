// Copy to config.js for local use (config.js is not committed).
// On GitHub Pages the deploy workflow writes config.js from the repository
// secrets SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.
window.JD_CONFIG = {
  supabaseUrl: "https://<project-ref>.supabase.co",
  publishableKey: "sb_publishable_...",
  pageSize: 50,
};
