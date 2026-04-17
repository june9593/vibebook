const UNSAFE = /[\\/:*?"<>|\s.,;!()[\]{}@#$%^&+=`~]+/g;

export function deriveSlug(firstUserMessage: string): { slug: string; display: string } {
  const collapsed = firstUserMessage.trim().replace(/\s+/g, " ");
  const display = collapsed.slice(0, 120) || "untitled";
  let slug = collapsed.replace(UNSAFE, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  slug = slug.slice(0, 60);
  if (!slug) slug = "untitled";
  return { slug, display };
}

export function toDisplayName(s: string): string {
  return s;
}

export function projectSlugFromPath(cwdOrPath: string): string {
  if (!cwdOrPath || cwdOrPath === "/") return "root";
  const parts = cwdOrPath.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  if (parts.length === 1) return parts[0];
  // Prefer "parent-basename" so `/Users/yueliu/edge/memvc` → "edge-memvc"
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent === "Users" || parent === "home") return "home";
  return `${parent}-${last}`;
}
