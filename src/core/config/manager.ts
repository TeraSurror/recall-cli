import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { type RecallConfig, defaultConfig } from "./schema.ts";
import { ConfigError } from "../../utils/errors.ts";

const CONFIG_DIR = join(homedir(), ".config", "recall-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DB_FILE = join(CONFIG_DIR, "vectors.db");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getDbPath(): string {
  return DB_FILE;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): RecallConfig {
  if (!configExists()) {
    throw new ConfigError(
      `Configuration not found. Run 'recall config init' first.`
    );
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const config = JSON.parse(content) as RecallConfig;
    return { ...defaultConfig, ...config };
  } catch (error) {
    throw new ConfigError(`Failed to load config: ${error}`);
  }
}

export function saveConfig(config: RecallConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    throw new ConfigError(`Failed to save config: ${error}`);
  }
}

export function updateConfig(updates: Partial<RecallConfig>): RecallConfig {
  const current = configExists() ? loadConfig() : defaultConfig;
  const updated = deepMerge(current, updates);
  saveConfig(updated);
  return updated;
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object"
    ) {
      result[key] = deepMerge(
        targetValue as object,
        sourceValue as object
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }
  return result;
}
