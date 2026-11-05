import { posix } from "node:path";

/** Extensions Obsidian treats as attachments rather than notes. */
export function isAttachmentTarget(target: string): boolean {
  const ext = posix.extname(target).toLowerCase();
  return ext !== "" && ext !== ".md" && /^\.[a-z0-9]{1,5}$/.test(ext);
}

/**
 * Resolves link targets to note paths with Obsidian's semantics:
 *  - `[[Note]]` matches by basename (case-insensitive); ties prefer the source's folder, then the shortest path.
 *  - `[[Folder/Note]]` matches an exact vault path, then any path ending in `/Folder/Note.md`.
 *  - `[[#Heading]]` (empty target) resolves to the source note itself.
 */
export class LinkResolver {
  private byName = new Map<string, string[]>();
  private byPath = new Map<string, string>();

  constructor(paths: Iterable<string>) {
    for (const p of paths) this.add(p);
  }

  add(path: string): void {
    this.byPath.set(path.toLowerCase(), path);
    const name = posix.basename(path, ".md").toLowerCase();
    const list = this.byName.get(name) ?? [];
    if (!list.includes(path)) list.push(path);
    this.byName.set(name, list);
  }

  remove(path: string): void {
    this.byPath.delete(path.toLowerCase());
    const name = posix.basename(path, ".md").toLowerCase();
    const list = this.byName.get(name)?.filter((p) => p !== path);
    if (list?.length) this.byName.set(name, list);
    else this.byName.delete(name);
  }

  resolve(target: string, sourcePath: string): string | null {
    if (target === "") return sourcePath;
    if (isAttachmentTarget(target)) return null;
    let t = target.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
    if (t.startsWith("./") || t.startsWith("../")) {
      t = posix.normalize(posix.join(posix.dirname(sourcePath), t));
    }
    const lower = t.toLowerCase();
    if (t.includes("/")) {
      const exact = this.byPath.get(`${lower}.md`);
      if (exact) return exact;
      const name = posix.basename(lower);
      const candidates = (this.byName.get(name) ?? []).filter((p) =>
        p.toLowerCase().endsWith(`/${lower}.md`),
      );
      return pickBest(candidates, sourcePath);
    }
    return pickBest(this.byName.get(lower) ?? [], sourcePath);
  }
}

function pickBest(candidates: string[], sourcePath: string): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const srcDir = posix.dirname(sourcePath);
  const sameDir = candidates.find((c) => posix.dirname(c) === srcDir);
  if (sameDir) return sameDir;
  return [...candidates].sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0]!;
}
