import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandsDir } from './commands/runtime-dir.js';

/**
 * TBP-713 — the product decisions a command never makes for the developer.
 *
 * The list is bridge-api's PRODUCT_DECISIONS, shipped here as the generated
 * `prompts/product-decisions.json` (bridge-api's guide-currency.spec.ts fails
 * when the two differ). A command missing one of these stops before writing
 * anything, exits non-zero with `DECISION_NEEDED`, and lists the same fields
 * the MCP tool would, plus the flag that answers each.
 */
export interface ProductDecision {
  tool: string;
  cli?: string;
  field: string;
  guide: string;
  enforcement: 'ask' | 'only-when-given';
  question: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  options?: string[];
}

export interface DecisionField {
  name: string;
  question: string;
  type: ProductDecision['type'];
  options?: string[];
  /** The flag (or spec key) that answers it on this command. */
  flag?: string;
}

let cached: ProductDecision[] | undefined;

/** `prompts/product-decisions.json`, from `dist/prompts` or the source tree. */
export function loadProductDecisions(): ProductDecision[] {
  if (cached) return cached;
  const candidates = [
    join(commandsDir, '..', 'prompts', 'product-decisions.json'),
    join(commandsDir, '..', '..', 'prompts', 'product-decisions.json'),
  ];
  for (const path of candidates) {
    try {
      cached = (JSON.parse(readFileSync(path, 'utf-8')) as { decisions: ProductDecision[] }).decisions;
      return cached;
    } catch {
      /* try next */
    }
  }
  throw new Error(`product-decisions.json not found. Tried: ${candidates.join(', ')}`);
}

/** One missing decision, by the MCP tool's field name; throws on a name not in the list. */
export function decisionField(tool: string, field: string, flag?: string, name: string = field): DecisionField {
  const d = loadProductDecisions().find((x) => x.tool === tool && x.field === field);
  if (!d) throw new Error(`No product decision ${tool}.${field} in product-decisions.json`);
  return { name, question: d.question, type: d.type, ...(d.options ? { options: [...d.options] } : {}), ...(flag ? { flag } : {}) };
}

/** Thrown before any write; outputError prints code, message, hint and fields and exits 1. */
export class DecisionNeededError extends Error {
  readonly code = 'DECISION_NEEDED';
  readonly hint: string;

  constructor(readonly command: string, readonly fields: DecisionField[], context?: string) {
    const names = fields.map((f) => f.name).join(', ');
    super(
      `${command} needs ${fields.length === 1 ? 'a product decision' : `${fields.length} product decisions`} ` +
        `the developer has not made: ${names}.${context ? ` ${context}` : ''} Nothing was changed.`,
    );
    this.name = 'DecisionNeededError';
    const guide = loadProductDecisions().find((d) => d.cli === command)?.guide;
    const flags = fields.map((f) => f.flag ?? f.name).join(' ');
    this.hint =
      `Ask the developer each question in fields and wait for the answers; do not choose values for them. ` +
      `Then run ${command} again with ${flags}.` +
      (guide ? ` \`bridge guide decision ${guide}\` says what each choice means.` : '');
  }
}
