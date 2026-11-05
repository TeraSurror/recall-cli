import { createInterface, type Interface } from "node:readline";
import { createInterface as createPromiseInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { RecallError } from "./errors.ts";

/** y/N prompt. Returns false when stdin isn't a terminal. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createPromiseInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * Line-based interactive prompts. Input lines are queued, so answers can also be piped in
 * (`printf 'a\nb\n' | recall setup`) or driven from tests with streams.
 */
export class Prompter {
  private rl: Interface;
  private queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;
  private muted = false;
  readonly interactive: boolean;

  constructor(
    private input: Readable & { isTTY?: boolean } = process.stdin,
    private output: Writable = process.stdout,
  ) {
    this.interactive = !!input.isTTY;
    this.rl = createInterface({ input, output, terminal: this.interactive });
    // Hide typed characters while reading secrets.
    const rlAny = this.rl as unknown as { _writeToOutput?: (s: string) => void };
    const orig = rlAny._writeToOutput?.bind(this.rl);
    rlAny._writeToOutput = (s: string) => {
      if (this.muted && !/^\r?\n$/.test(s)) return;
      if (orig) orig(s);
      else output.write(s);
    };
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(line);
      } else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
    });
  }

  write(text: string): void {
    this.output.write(text);
  }

  private nextLine(): Promise<string> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(new RecallError("Input ended before setup finished."));
    return new Promise((resolve, reject) => {
      this.waiting = (line) => (line === null ? reject(new RecallError("Input ended before setup finished.")) : resolve(line));
    });
  }

  async ask(question: string, def?: string): Promise<string> {
    this.write(`${question}${def ? ` (${def})` : ""}: `);
    const answer = (await this.nextLine()).trim();
    if (!this.interactive) this.write("\n");
    return answer || def || "";
  }

  async required(question: string, def?: string): Promise<string> {
    for (;;) {
      const v = await this.ask(question, def);
      if (v) return v;
      this.write("  (required)\n");
    }
  }

  async confirm(question: string, def = true): Promise<boolean> {
    for (;;) {
      const v = (await this.ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
      if (!v) return def;
      if (["y", "yes"].includes(v)) return true;
      if (["n", "no"].includes(v)) return false;
    }
  }

  /** Numbered menu. Accepts the number or an exact label. */
  async select<T>(question: string, choices: Choice<T>[], defIndex = 0): Promise<T> {
    this.write(`${question}\n`);
    choices.forEach((c, i) => this.write(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? `  — ${c.hint}` : ""}\n`));
    for (;;) {
      const v = await this.ask("Choose", String(defIndex + 1));
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
      const byLabel = choices.find((c) => c.label.toLowerCase() === v.toLowerCase());
      if (byLabel) return byLabel.value;
      this.write(`  Enter a number from 1 to ${choices.length}.\n`);
    }
  }

  async secret(question: string): Promise<string> {
    this.write(`${question}: `);
    this.muted = this.interactive;
    try {
      const v = (await this.nextLine()).trim();
      this.write("\n");
      return v;
    } finally {
      this.muted = false;
    }
  }

  close(): void {
    this.rl.close();
  }
}
