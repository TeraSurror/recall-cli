import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { ConfigSchema, DEFAULT_CONFIG_TEXT, type Config } from "./schema.ts";
import { configFile } from "./paths.ts";
import { RecallError } from "../util/errors.ts";

export interface LoadedConfig {
  config: Config;
  path: string;
  /** True when the file didn't exist and defaults are being used. */
  isDefault: boolean;
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function parseConfigText(text: string, path = "<config>"): Config {
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0]!;
    const line = text.slice(0, e.offset).split("\n").length;
    throw new RecallError(`${path}:${line}: ${printParseErrorCode(e.error)}`);
  }
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new RecallError(`Invalid config at ${path}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(path = configFile()): LoadedConfig {
  const text = readText(path);
  if (text === null) {
    return { config: parseConfigText(DEFAULT_CONFIG_TEXT), path, isDefault: true };
  }
  return { config: parseConfigText(text, path), path, isDefault: false };
}

/** Create the config file from the commented template if it doesn't exist. */
export function ensureConfigFile(path = configFile()): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_CONFIG_TEXT);
}

/**
 * Apply a targeted edit to the config file, preserving comments and formatting.
 * `value: undefined` removes the key. The result is validated before writing.
 */
export function editConfig(
  edits: Array<{ path: (string | number)[]; value: unknown }>,
  path = configFile(),
): Config {
  ensureConfigFile(path);
  let text = readFileSync(path, "utf8");
  for (const edit of edits) {
    const ops = modify(text, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    text = applyEdits(text, ops);
  }
  const config = parseConfigText(text, path); // throws before writing if invalid
  writeFileSync(path, text);
  return config;
}
