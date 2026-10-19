import { fetchGoCatalogue, normalizeGoModels, diffCatalogues, type GoModel } from "./opencode-models.js";
import { CatalogueStore } from "./opencode-catalogue.js";
import { modelRoutes } from "./provider-chain.js";

// Model ids that Dr Watson already routes through OpenCode Go in one of the
// task tiers. A discovered model that is not here is a candidate for review,
// not an automatic routing change.
function routedGoModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const tier of ["cheap", "standard", "hard"] as const) {
    for (const route of modelRoutes(tier, "auto")) {
      if (route.provider === "opencode" && route.model) ids.add(route.model);
    }
  }
  return ids;
}

function isRouted(id: string, routed: Set<string>): boolean {
  return routed.has(id);
}

async function run(): Promise<number> {
  const json = process.argv.includes("--json");
  const log = json ? () => undefined : (message: string) => console.log(message);
  const errorLog = json ? () => undefined : (message: string) => console.error(message);

  let raw;
  try {
    raw = await fetchGoCatalogue({ fetchFn: globalThis.fetch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { error: message, checkedAt: new Date().toISOString() };
    if (json) console.log(JSON.stringify(result));
    else errorLog(`check-models: ${message}`);
    return 1;
  }

  const models = normalizeGoModels(raw);
  const checkedAt = new Date().toISOString();
  const store = new CatalogueStore();
  let previous: GoModel[] | undefined;
  try {
    previous = store.getPreviousModels();
    store.saveSnapshot(models, raw, checkedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { error: message, checkedAt };
    if (json) console.log(JSON.stringify(result));
    else errorLog(`check-models: ${message}`);
    store.close();
    return 1;
  }
  store.close();

  const diff = previous ? diffCatalogues(previous, models)
    : { added: models, removed: [], changed: [] };
  const routed = routedGoModelIds();

  if (json) {
    console.log(JSON.stringify({
      checkedAt,
      total: models.length,
      added: diff.added.map((model) => model.id),
      removed: diff.removed.map((model) => model.id),
      changed: diff.changed,
      candidates: diff.added.filter((model) => !isRouted(model.id, routed)).map((model) => model.id),
    }, null, 2));
    return 0;
  }

  log(`OpenCode Go models — last checked ${new Date(checkedAt).toLocaleString()}`);
  log(`Total Go models: ${models.length}`);

  if (diff.added.length) {
    log("\nNEW");
    for (const model of diff.added) {
      log(`  ${model.id}${isRouted(model.id, routed) ? "" : "   (not routed — candidate for review)"}`);
    }
  }
  if (diff.removed.length) {
    log("\nREMOVED");
    for (const model of diff.removed) log(`  ${model.id}`);
  }
  if (diff.changed.length) {
    log("\nCHANGED");
    for (const { model, field, old, new: newValue } of diff.changed) {
      log(`  ${model}.${field}: ${JSON.stringify(old)} → ${JSON.stringify(newValue)}`);
    }
  }
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    log("\nNo changes since the last check.");
  }

  const newCandidates = diff.added.filter((model) => !isRouted(model.id, routed));
  if (newCandidates.length) {
    log(`\n${newCandidates.length} new model(s) not currently routed.`);
    log("Review them before adding to TIER_ROUTES in src/provider-chain.ts.");
  }

  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`check-models: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
