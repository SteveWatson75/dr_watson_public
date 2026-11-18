import {
  Agent,
  run,
  tool,
  setTracingDisabled,
  setSensitiveDataLoggingEnabled,
} from "@openai/agents";
import { z } from "zod";
import { budgetLedger } from "../budget.js";
import { providerApiKey } from "../config.js";
import { guardedModel } from "./provider.js";

// Explicit, owner-authorized invocation only; never imported by CI tests.
const provider = process.argv[3];
if (
  process.argv[2] !== "--run" ||
  !["anthropic", "gemini"].includes(provider ?? "") ||
  process.env.CI
) {
  console.error("Local only: npx tsx src/providers/provider-smoke.ts --run <anthropic|gemini>");
  process.exitCode = 1;
} else if (provider === "anthropic" || provider === "gemini") {
  setTracingDisabled(true);
  setSensitiveDataLoggingEnabled(false);
  process.env.OPENAI_LOG = "off";
  const ledger = budgetLedger();
  const model = guardedModel([{ provider }], ledger);
  const settings = { maxTokens: 256 };
  try {
    if (!providerApiKey(provider)) throw new Error("Missing credentials");
    const text = await run(
      new Agent({
        name: "Text smoke",
        model,
        modelSettings: settings,
      }),
      "Reply with one short greeting.",
      { maxTurns: 1 },
    );
    if (!text.finalOutput?.trim()) throw new Error("No text output");
    console.info(`${provider}: text PASS`);

    let called = false;
    const echo = tool({
      name: "echo",
      description: "Echo a synthetic value.",
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        called = true;
        return value;
      },
    });
    await run(
      new Agent({
        name: "Tool smoke",
        model,
        modelSettings: settings,
        tools: [echo],
        instructions:
          "Call echo once with value hello, then reply briefly. Do not call other tools.",
      }),
      "Use echo now.",
      { maxTurns: 2 },
    );
    if (!called) throw new Error("No tool call");
    console.info(`${provider}: tool round trip PASS`);

    const structured = await run(
      new Agent({
        name: "JSON smoke",
        model,
        modelSettings: settings,
        outputType: z.object({ ok: z.boolean() }),
      }),
      "Return ok true.",
      { maxTurns: 1 },
    );
    if (structured.finalOutput?.ok !== true) throw new Error("Unexpected structured value");
    console.info(`${provider}: structured output PASS`);
  } catch {
    // Provider/SDK error messages can echo request data: never print them here.
    console.error(
      `${provider}: smoke check FAILED; check credentials, model access and budget locally.`,
    );
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}
