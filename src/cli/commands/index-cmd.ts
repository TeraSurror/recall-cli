import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../../core/config/manager.ts";
import { scanVault } from "../../core/vault/scanner.ts";
import { parseDocument } from "../../core/document/parser.ts";
import { chunkDocument } from "../../core/document/chunker.ts";
import { VectorStore } from "../../core/vector/store.ts";
import { createEmbeddingProvider } from "../../llm/factory.ts";
import { logger } from "../../utils/logger.ts";

export function createIndexCommand(): Command {
  return new Command("index")
    .description("Index your Obsidian vault")
    .option("--force", "Re-index all files even if unchanged")
    .option("--dry-run", "Show what would be indexed without making changes")
    .action(async (options: { force?: boolean; dryRun?: boolean }) => {
      try {
        const config = loadConfig();
        const spinner = ora("Scanning vault...").start();

        const files = await scanVault(
          config.vault.path,
          config.vault.excludePatterns
        );

        spinner.text = `Found ${files.length} markdown files`;

        if (options.dryRun) {
          spinner.info(`Would index ${files.length} files`);
          files.slice(0, 10).forEach((f) => {
            console.log(chalk.dim(`  - ${f.relativePath}`));
          });
          if (files.length > 10) {
            console.log(chalk.dim(`  ... and ${files.length - 10} more`));
          }
          return;
        }

        const store = new VectorStore(config.embeddings.dimensions);
        const embedder = createEmbeddingProvider(config);

        let indexed = 0;
        let skipped = 0;
        let totalChunks = 0;

        for (const file of files) {
          spinner.text = `Indexing: ${file.relativePath}`;

          const existingDoc = store.getDocument(file.relativePath);
          if (
            !options.force &&
            existingDoc &&
            new Date(existingDoc.modified_at) >= file.modifiedAt
          ) {
            skipped++;
            continue;
          }

          try {
            const parsed = parseDocument(file.path);
            const chunks = chunkDocument(parsed.content);

            const docId = store.insertDocument(
              file.relativePath,
              parsed.metadata.title,
              parsed.content,
              { ...parsed.metadata } as Record<string, unknown>,
              file.modifiedAt
            );

            store.deleteDocumentChunks(docId);

            const chunkTexts = chunks.map((c) => c.content);
            const embeddings = await embedder.embedBatch(chunkTexts);

            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i]!;
              const embedding = embeddings[i] || null;
              store.insertChunk(
                docId,
                chunk.content,
                chunk.index,
                chunk.heading || null,
                chunk.startLine,
                chunk.endLine,
                embedding
              );
            }

            totalChunks += chunks.length;
            indexed++;
          } catch (error) {
            logger.warn(`Failed to index ${file.relativePath}: ${error}`);
          }
        }

        store.close();
        spinner.succeed("Indexing complete!");

        console.log(chalk.green(`\nIndexed: ${indexed} files (${totalChunks} chunks)`));
        if (skipped > 0) {
          console.log(chalk.dim(`Skipped: ${skipped} unchanged files`));
        }
      } catch (error) {
        logger.error(String(error));
        process.exit(1);
      }
    });
}
