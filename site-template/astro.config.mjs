import { defineConfig } from "astro/config";

// VIBEBOOK_REPO_PATH points at the user's session-repo (set by `vibebook
// serve` / `vibebook build-site` before invoking astro). Default to
// `~/.vibebook/session-repo` so `astro dev` works standalone too.
const repoPath =
  process.env.VIBEBOOK_REPO_PATH ||
  `${process.env.HOME}/.vibebook/session-repo`;

export default defineConfig({
  // Anything published-ish: GitHub Pages will set the right base via
  // VIBEBOOK_SITE_BASE; for local dev we serve at /.
  site: process.env.VIBEBOOK_SITE_URL || "http://localhost:4321",
  base: process.env.VIBEBOOK_SITE_BASE || "/",
  output: "static",
  trailingSlash: "always",
  vite: {
    define: {
      "import.meta.env.VIBEBOOK_REPO_PATH": JSON.stringify(repoPath),
    },
  },
  markdown: {
    syntaxHighlight: "shiki",
    shikiConfig: {
      // Light theme on parchment backgrounds; we explicitly do not switch on
      // prefers-color-scheme to keep the warm aesthetic.
      theme: "github-light",
      wrap: true,
    },
  },
});
