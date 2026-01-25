import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { glob } from "glob";
import { loadConfig } from "../../core/config/manager.ts";
import { createLLMProvider } from "../../llm/factory.ts";
import { parseDocument } from "../../core/document/parser.ts";
import type { Message } from "../../llm/types.ts";
import { logger } from "../../utils/logger.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.setOptions({ renderer: new TerminalRenderer() as any });

export function createSummarizeCommand(): Command {
  return new Command("summarize")
    .description("Summarize notes or folders")
    .argument("[path]", "Path to note or folder (relative to vault)")
    .option("--detailed", "Generate a more detailed summary")
    .option("--bullets", "Format as bullet points")
    .action(
      async (
        notePath: string | undefined,
        options: { detailed?: boolean; bullets?: boolean }
      ) => {
        try {
          const config = loadConfig();
          const spinner = ora("Loading notes...").start();

          let contents: { path: string; content: string; title: string }[] = [];

          if (notePath) {
            const fullPath = join(config.vault.path, notePath);
            const stats = statSync(fullPath);

            if (stats.isDirectory()) {
              const files = await glob("**/*.md", {
                cwd: fullPath,
                absolute: true,
              });

              for (const file of files.slice(0, 20)) {
                const parsed = parseDocument(file);
                contents.push({
                  path: relative(config.vault.path, file),
                  content: parsed.content,
                  title: parsed.metadata.title,
                });
              }
            } else {
              const parsed = parseDocument(fullPath);
              contents.push({
                path: notePath,
                content: parsed.content,
                title: parsed.metadata.title,
              });
            }
          } else {
            const files = await glob("**/*.md", {
              cwd: config.vault.path,
              absolute: true,
              ignore: config.vault.excludePatterns,
            });

            const recentFiles = files
              .map((f) => ({ path: f, mtime: statSync(f).mtime }))
              .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
              .slice(0, 10);

            for (const file of recentFiles) {
              const parsed = parseDocument(file.path);
              contents.push({
                path: relative(config.vault.path, file.path),
                content: parsed.content,
                title: parsed.metadata.title,
              });
            }
          }

          if (contents.length === 0) {
            spinner.info("No notes found to summarize");
            return;
          }

          spinner.text = `Summarizing ${contents.length} note(s)...`;

          const llm = createLLMProvider(config);

          const notesText = contents
            .map((n) => `## ${n.title}\n${n.content}`)
            .join("\n\n---\n\n");

          const formatInstruction = options.bullets
            ? "Format your response as bullet points."
            : "Format your response as prose paragraphs.";

          const detailLevel = options.detailed
            ? "Provide a comprehensive, detailed summary covering all major topics and themes."
            : "Provide a concise summary highlighting the key points.";

          const messages: Message[] = [
            {
              role: "system",
              content: `You are a helpful assistant that summarizes notes. ${detailLevel} ${formatInstruction}`,
            },
            {
              role: "user",
              content: `Please summarize the following notes:\n\n${notesText}`,
            },
          ];

          spinner.stop();

          console.log(chalk.bold("\nSummary:\n"));

          let summary = "";
          for await (const chunk of llm.stream(messages, {
            temperature: 0.5,
            maxTokens: config.llm.maxTokens,
          })) {
            process.stdout.write(chunk.content);
            summary += chunk.content;
          }

          console.log("\n");
          console.log(chalk.dim(`Sources: ${contents.map((c) => c.path).join(", ")}`));
        } catch (error) {
          logger.error(String(error));
          process.exit(1);
        }
      }
    );
}
