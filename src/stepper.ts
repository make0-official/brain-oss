import * as clack from "@clack/prompts";
import pc from "picocolors";
import { parseClientSelection } from "./init/select";

/** How the plain stepper talks to the person; a script in tests, a pipe where clack can't draw. */
export type PromptIO = {
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
};

export type Choice<T> = {
  label: string;
  value: T;
  /** Shown dimmed after the label: a count, a path, a date. */
  hint?: string;
  /** Typed instead of a number in the plain stepper; defaults to the label. */
  id?: string;
};

/** One run of numbered steps. Every question has a default, so Enter always moves on. */
export interface StepUI {
  select<T>(title: string, question: string, choices: Choice<T>[], defaultIndex?: number): Promise<T>;
  /** Enter takes all, or none when `enterTakesAll` is false. */
  multi<T>(title: string, question: string, choices: Choice<T>[], enterTakesAll?: boolean): Promise<T[]>;
  /** A `title` starts a new step; without one the question belongs to the current step. */
  text(title: string | null, question: string, fallback?: string, validate?: (value: string) => string | null): Promise<string>;
  /** The last step: what is about to happen, then yes or no. */
  confirm(title: string, summary: string[], question: string, defaultYes?: boolean): Promise<boolean>;
  log(line: string): void;
}

/** Starts a stepper of `total` steps (unknown when omitted). */
export type Steps = (total?: number) => StepUI;

/** Ctrl+C or Esc in a step. */
export class StepsCancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

/** Steps only run for a person at a terminal, and `--yes` always skips them. */
export function canPrompt(args: string[] = []): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes("--yes") && !args.includes("-y");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatChoices<T>(choices: Choice<T>[]): string[] {
  const width = Math.max(...choices.map((choice) => choice.label.length));
  return choices.map((choice, index) => {
    const hint = choice.hint ? `  ${choice.hint}` : "";
    return `  ${String(index + 1).padStart(2)}. ${choice.label.padEnd(hint ? width : 0)}${hint}`;
  });
}

/** Numbered lists and typed answers: "Step 2 of 3 · Brain", then a question. */
export class TextStepper implements StepUI {
  private current = 0;

  constructor(
    private readonly io: PromptIO,
    private readonly total?: number,
  ) {}

  private header(title: string): void {
    this.current += 1;
    const position = this.total ? `Step ${this.current} of ${this.total}` : `Step ${this.current}`;
    this.io.log(`\n${position} · ${title}`);
  }

  log(line: string): void {
    this.io.log(line);
  }

  async select<T>(title: string, question: string, choices: Choice<T>[], defaultIndex = 0): Promise<T> {
    this.header(title);
    for (const line of formatChoices(choices)) this.io.log(line);
    for (;;) {
      const answer = (await this.io.ask(`\n${question} [${defaultIndex + 1}]: `)).trim();
      if (answer === "") return choices[defaultIndex].value;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1].value;
      const byId = choices.find((choice) => (choice.id ?? choice.label).toLowerCase() === answer.toLowerCase());
      if (byId) return byId.value;
      this.io.log(`  Use 1-${choices.length}.`);
    }
  }

  async multi<T>(title: string, question: string, choices: Choice<T>[], enterTakesAll = true): Promise<T[]> {
    this.header(title);
    for (const line of formatChoices(choices)) this.io.log(line);
    const keyed = choices.map((choice) => ({ ...choice, id: (choice.id ?? choice.label).toLowerCase() }));
    const fallback = enterTakesAll ? "all" : "none";
    for (;;) {
      const raw = await this.io.ask(`\n${question} Numbers (1,3 or 1-3) or ids. Enter for ${fallback} [${fallback}]: `);
      const picked = parseClientSelection(raw.trim() === "" ? fallback : raw, keyed);
      if (picked) return picked.map((choice) => choice.value);
      this.io.log(`  Use 1-${choices.length}, ids, all, or none.`);
    }
  }

  async text(title: string | null, question: string, fallback = "", validate?: (value: string) => string | null): Promise<string> {
    if (title) this.header(title);
    for (;;) {
      const suffix = fallback ? ` [${fallback}]` : "";
      const value = (await this.io.ask(`${title ? "\n" : ""}${question}${suffix}: `)).trim() || fallback;
      const problem = validate?.(value) ?? null;
      if (!problem) return value;
      this.io.log(`  ${problem}`);
    }
  }

  async confirm(title: string, summary: string[], question: string, defaultYes = true): Promise<boolean> {
    this.header(title);
    for (const line of summary) this.io.log(`  ${line}`);
    const answer = (await this.io.ask(`\n${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
    return answer === "" ? defaultYes : answer === "y" || answer === "yes";
  }
}

export function textSteps(io: PromptIO): Steps {
  return (total) => new TextStepper(io, total);
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new StepsCancelled();
  return value as Exclude<T, symbol>;
}

/** Arrow keys, checkboxes and a connected rail, drawn by @clack/prompts. */
export class ClackStepper implements StepUI {
  private current = 0;

  constructor(private readonly total?: number) {}

  private label(title: string, question: string): string {
    this.current += 1;
    const position = this.total ? pc.dim(` · step ${this.current}/${this.total}`) : "";
    return `${pc.bold(title)}${position}\n${question}`;
  }

  log(line: string): void {
    clack.log.message(line.trim());
  }

  async select<T>(title: string, question: string, choices: Choice<T>[], defaultIndex = 0): Promise<T> {
    const index = unwrap(
      await clack.select({
        message: this.label(title, question),
        options: choices.map((choice, position) => ({ value: position, label: choice.label, hint: choice.hint })),
        initialValue: defaultIndex,
        maxItems: 12,
      }),
    );
    return choices[index].value;
  }

  async multi<T>(title: string, question: string, choices: Choice<T>[], enterTakesAll = true): Promise<T[]> {
    const picked = unwrap(
      await clack.multiselect({
        message: `${this.label(title, question)} ${pc.dim("(space to toggle, enter to confirm)")}`,
        options: choices.map((choice, position) => ({ value: position, label: choice.label, hint: choice.hint })),
        initialValues: enterTakesAll ? choices.map((_, position) => position) : [],
        required: false,
        maxItems: 12,
      }),
    );
    return picked.map((position) => choices[position].value);
  }

  async text(title: string | null, question: string, fallback = "", validate?: (value: string) => string | null): Promise<string> {
    const value = unwrap(
      await clack.text({
        // clack draws no rail beside a text prompt's second line, so title and question share one.
        message: title ? this.label(title, question).replace("\n", pc.dim(" — ")) : question,
        placeholder: fallback || undefined,
        defaultValue: fallback,
        validate: validate ? (input) => validate((input ?? "").trim() || fallback) ?? undefined : undefined,
      }),
    );
    return value.trim() || fallback;
  }

  async confirm(title: string, summary: string[], question: string, defaultYes = true): Promise<boolean> {
    this.current += 1;
    const position = this.total ? `${this.current}/${this.total}` : `${this.current}`;
    clack.note(summary.join("\n"), `${title} · step ${position}`);
    return unwrap(await clack.confirm({ message: question, initialValue: defaultYes }));
  }
}

export function clackSteps(): Steps {
  return (total) => new ClackStepper(total);
}

let introShown = false;

/** The frame around a run of steps: a title bar, a spinner for slow work, a closing line. */
export const ui = {
  /** Drawn once per run, so a command picked from the menu keeps the menu's title bar. */
  intro: (subtitle?: string) => {
    if (introShown) return;
    introShown = true;
    clack.intro(`${pc.bgCyan(pc.black(" Make0 Brain "))}${subtitle ? ` ${pc.dim(subtitle)}` : ""}`);
  },
  outro: (message: string) => clack.outro(message),
  cancel: (message = "Cancelled.") => clack.cancel(message),
  spinner: () => clack.spinner(),
  note: (lines: string[], title?: string) => clack.note(lines.join("\n"), title),
  success: (message: string) => clack.log.success(message),
  warn: (message: string) => clack.log.warn(message),
  info: (message: string) => clack.log.info(message),
};
