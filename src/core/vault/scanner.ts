import { glob } from "glob";
import { join, relative } from "path";
import { statSync } from "fs";
import { VaultError } from "../../utils/errors.ts";

export interface VaultFile {
  path: string;
  relativePath: string;
  name: string;
  modifiedAt: Date;
}

export async function scanVault(
  vaultPath: string,
  excludePatterns: string[] = []
): Promise<VaultFile[]> {
  try {
    const pattern = "**/*.md";
    const ignore = excludePatterns.map((p) => join(vaultPath, p));

    const files = await glob(pattern, {
      cwd: vaultPath,
      ignore,
      absolute: true,
      nodir: true,
    });

    return files.map((filePath) => {
      const stats = statSync(filePath);
      const relativePath = relative(vaultPath, filePath);
      const name = relativePath.replace(/\.md$/, "");

      return {
        path: filePath,
        relativePath,
        name,
        modifiedAt: stats.mtime,
      };
    });
  } catch (error) {
    throw new VaultError(`Failed to scan vault: ${error}`);
  }
}

export function getVaultStats(files: VaultFile[]): {
  totalFiles: number;
  lastModified: Date | null;
} {
  const totalFiles = files.length;
  const lastModified =
    files.length > 0
      ? new Date(Math.max(...files.map((f) => f.modifiedAt.getTime())))
      : null;

  return { totalFiles, lastModified };
}
