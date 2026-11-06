import { RecallError } from "../util/errors.ts";

const SERVICE = "recall-cli";

/**
 * Resolve an `apiKey` config value:
 *  - undefined        → undefined (provider SDK falls back to its default env var)
 *  - "env:NAME"       → process.env.NAME
 *  - "keychain:NAME"  → OS credential store (macOS Keychain, libsecret, Windows Credential Manager)
 *  - anything else    → literal key
 */
export async function resolveSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (value.startsWith("env:")) {
    const name = value.slice(4);
    const v = process.env[name];
    if (!v) throw new RecallError(`Environment variable ${name} is not set`);
    return v;
  }
  if (value.startsWith("keychain:")) {
    const name = value.slice(9);
    const v = await Bun.secrets.get({ service: SERVICE, name });
    if (!v) {
      throw new RecallError(
        `No key named "${name}" in the OS keychain`,
        `Store it with: recall model key set ${name}`,
      );
    }
    return v;
  }
  return value;
}

export async function storeSecret(name: string, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name, value });
}

export async function deleteSecret(name: string): Promise<boolean> {
  return Bun.secrets.delete({ service: SERVICE, name });
}
