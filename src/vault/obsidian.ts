import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface DailyNoteSettings {
  folder: string;
  /** Moment.js-style format, e.g. "YYYY-MM-DD". */
  format: string;
  template?: string;
}

export interface ObsidianSettings {
  dailyNotes: DailyNoteSettings;
  newFileFolder: string;
  attachmentFolder: string;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function isObsidianVault(root: string): boolean {
  return existsSync(join(root, ".obsidian"));
}

/** Read the vault's Obsidian settings that matter to an agent. Missing files → Obsidian defaults. */
export function readObsidianSettings(root: string): ObsidianSettings {
  const dir = join(root, ".obsidian");
  const daily = readJson(join(dir, "daily-notes.json"));
  // The Periodic Notes plugin overrides core daily notes when present.
  const periodic = readJson(join(dir, "plugins", "periodic-notes", "data.json"));
  const pDaily = (periodic.daily ?? {}) as Record<string, unknown>;
  const usePeriodic = pDaily.enabled === true;
  const app = readJson(join(dir, "app.json"));

  const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    dailyNotes: {
      folder: str(usePeriodic ? pDaily.folder : daily.folder),
      format: str(usePeriodic ? pDaily.format : daily.format, "YYYY-MM-DD"),
      template: str(usePeriodic ? pDaily.templatePath : daily.template) || undefined,
    },
    newFileFolder: app.newFileLocation === "folder" ? str(app.newFileFolderPath) : "",
    attachmentFolder: str(app.attachmentFolderPath),
  };
}

/** Format a date with the subset of Moment.js tokens people use in daily-note formats. */
export function formatMomentDate(d: Date, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => months[d.getMonth()]!,
    MMM: () => months[d.getMonth()]!.slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DDDD: () => {
      const start = new Date(d.getFullYear(), 0, 0);
      return pad(Math.floor((d.getTime() - start.getTime()) / 86_400_000), 3);
    },
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => days[d.getDay()]!,
    ddd: () => days[d.getDay()]!.slice(0, 3),
    HH: () => pad(d.getHours()),
    mm: () => pad(d.getMinutes()),
  };
  // [escaped text] is literal in Moment.
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DD|D|dddd|ddd|HH|mm/g, (m, lit) =>
    lit !== undefined ? lit : tokens[m]!(),
  );
}

/** Location of Obsidian's own registry of known vaults. */
export function obsidianRegistryPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "obsidian", "obsidian.json");
  }
}

/** Vault paths Obsidian knows about (for `recall vault discover`). Never auto-registers anything. */
export function discoverObsidianVaults(registry = obsidianRegistryPath()): string[] {
  const data = readJson(registry) as { vaults?: Record<string, { path?: string }> };
  return Object.values(data.vaults ?? {})
    .map((v) => v.path)
    .filter((p): p is string => typeof p === "string" && existsSync(p));
}
