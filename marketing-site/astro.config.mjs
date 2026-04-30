import { defineConfig } from "astro/config";

// GitHub Pages serves project sites at /<repo>/. Locally we serve at /.
// CI sets VIBEBOOK_PAGES_BASE = "/vibebook/" and VIBEBOOK_PAGES_URL =
// "https://june9593.github.io/vibebook/".
export default defineConfig({
  site: process.env.VIBEBOOK_PAGES_URL || "http://localhost:4321",
  base: process.env.VIBEBOOK_PAGES_BASE || "/",
  output: "static",
  trailingSlash: "always",
});
