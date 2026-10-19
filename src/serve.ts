import { assertConfig, setupMessages } from "./config.js";
import { budgetLedger, formatBudget } from "./budget.js";
import { configureModelProvider } from "./provider.js";
import { createLocalApi } from "./local-api.js";

assertConfig();
configureModelProvider();
const server = createLocalApi();
server.on("error", (error) => { console.error(`Local API could not start: ${error.message}`); process.exitCode = 1; });
server.listen(8787, "127.0.0.1", () => {
  console.log("Dr Watson local API: http://127.0.0.1:8787/v1 (dr-watson-auto)");
  console.log(setupMessages().join("\n"));
  console.log(formatBudget(budgetLedger().status()));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close(() => { budgetLedger().close(); });
});
