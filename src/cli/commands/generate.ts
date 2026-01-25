import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config/manager.ts";
import { VectorStore } from "../../core/vector/store.ts";
import { createLLMProvider, createEmbeddingProvider } from "../../llm/factory.ts";
import { assembleContext, formatContextForPrompt } from "../../core/context/assembler.ts";
import type { Message } from "../../llm/types.ts";
import { logger } from "../../utils/logger.ts";

export function createGenerateCommand(): Command {
  return new Command("generate")
    .description("Generate a new note using AI")
    .argument("<prompt>", "Description of the note to generate")
    .option("-o, --output <path>", "Output path (relative to vault)")
    .option("--no-context", "Generate without context from existing notes")
    .option("--template <template>", "Note template (default, daily, meeting, project)")
    .action(
      async (
        prompt: string,
        options: {
          output?: string;
          context: boolean;
          template?: string;
        }
      ) => {
        try {
          const config = loadConfig();
          const spinner = ora("Generating note...").start();

          let contextText = "";

          if (options.context) {
            spinner.text = "Gathering context from existing notes...";
            const store = new VectorStore(config.embeddings.dimensions);
            const embedder = createEmbeddingProvider(config);

            const queryEmbedding = await embedder.embed(prompt);
            const results = store.searchSimilar(
              queryEmbedding,
              config.search.topK,
              0.5
            );

            const context = assembleContext(results);
            contextText = formatContextForPrompt(context);
            store.close();
          }

          const llm = createLLMProvider(config);

          const templateInstructions = getTemplateInstructions(options.template);

          const systemPrompt = `You are a helpful assistant that creates well-structured Obsidian notes.

${templateInstructions}

Guidelines:
- Use proper markdown formatting
- Include relevant frontmatter (title, tags, date)
- Use headers to organize content
- Include internal links [[like this]] where relevant
- Be thorough but concise

${
  contextText
    ? `Here is context from existing notes that may be relevant:\n\n${contextText}`
    : ""
}`;

          const messages: Message[] = [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Create a note about: ${prompt}`,
            },
          ];

          spinner.text = "Generating content...";

          const response = await llm.chat(messages, {
            temperature: 0.7,
            maxTokens: config.llm.maxTokens,
          });

          spinner.stop();

          console.log(chalk.bold("\nGenerated Note:\n"));
          console.log(chalk.dim("─".repeat(60)));
          console.log(response.content);
          console.log(chalk.dim("─".repeat(60)));

          if (options.output) {
            const fullPath = join(config.vault.path, options.output);

            if (existsSync(fullPath)) {
              const { overwrite } = await inquirer.prompt([
                {
                  type: "confirm",
                  name: "overwrite",
                  message: `File ${options.output} already exists. Overwrite?`,
                  default: false,
                },
              ]);

              if (!overwrite) {
                logger.info("Note not saved.");
                return;
              }
            }

            writeFileSync(fullPath, response.content);
            logger.success(`Note saved to ${options.output}`);
          } else {
            const { save } = await inquirer.prompt([
              {
                type: "confirm",
                name: "save",
                message: "Save this note to your vault?",
                default: true,
              },
            ]);

            if (save) {
              const { filename } = await inquirer.prompt([
                {
                  type: "input",
                  name: "filename",
                  message: "Enter filename (without .md):",
                  validate: (input: string) =>
                    input.trim() ? true : "Filename is required",
                },
              ]);

              const fullPath = join(config.vault.path, `${filename.trim()}.md`);

              if (existsSync(fullPath)) {
                const { overwrite } = await inquirer.prompt([
                  {
                    type: "confirm",
                    name: "overwrite",
                    message: "File already exists. Overwrite?",
                    default: false,
                  },
                ]);

                if (!overwrite) {
                  logger.info("Note not saved.");
                  return;
                }
              }

              writeFileSync(fullPath, response.content);
              logger.success(`Note saved to ${filename.trim()}.md`);
            }
          }
        } catch (error) {
          logger.error(String(error));
          process.exit(1);
        }
      }
    );
}

function getTemplateInstructions(template?: string): string {
  switch (template) {
    case "daily":
      return `Create a daily note with the following structure:
- Date in the title
- Sections for: Tasks, Notes, Reflections
- Use checkboxes for tasks`;

    case "meeting":
      return `Create a meeting note with the following structure:
- Meeting title and date
- Sections for: Attendees, Agenda, Discussion, Action Items
- Use bullet points for clarity`;

    case "project":
      return `Create a project note with the following structure:
- Project name and status
- Sections for: Overview, Goals, Tasks, Resources, Timeline
- Link to related notes where appropriate`;

    default:
      return `Create a well-structured note with appropriate headers and sections.`;
  }
}
