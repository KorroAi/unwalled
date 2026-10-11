import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { Engine } from "../../src/core.js";

const PETSTORE = fileURLToPath(new URL("../fixtures/petstore.yaml", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "unwalled-team-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** An engine with its own data directory, optionally reading a team catalogue. @param {string} name @param {string} [team] */
function engineFor(name, team) {
  process.env.UNWALLED_HOME = join(root, name);
  if (team) process.env.UNWALLED_TEAM_RECIPES = team;
  else delete process.env.UNWALLED_TEAM_RECIPES;
  return new Engine(loadConfig());
}

/** Publishes a recipe to the team folder the way a colleague would: export from their own installation. */
async function publish(team, name) {
  const author = engineFor(`author-${name}`);
  try {
    await author.importFile({ name, path: PETSTORE, baseUrl: "https://pets.example/v1" });
    mkdirSync(team, { recursive: true });
    copyFileSync(join(root, `author-${name}`, "recipes", `${name}.json`), join(team, `${name}.json`));
  } finally {
    await author.close();
  }
}

describe("team recipe catalogue (UNWALLED_TEAM_RECIPES)", () => {
  const team = join(root, "team");

  it("serves the team's recipes as tools, marked as such", async () => {
    await publish(team, "pets");
    const engine = engineFor("alice", team);
    try {
      assert.ok(engine.recipes.has("pets"));
      assert.equal(engine.store.isTeamRecipe("pets"), true);
      assert.ok(engine.tools.has("pets__list_pets"));
      await assert.rejects(engine.forget("pets"), /comes from the team catalogue/);
      assert.ok(existsSync(join(team, "pets.json")), "the shared recipe is never deleted from a personal installation");
    } finally {
      await engine.close();
    }
  });

  it("saves changes as a personal copy, and brings the team's version back when that copy is deleted", async () => {
    const engine = engineFor("bob", team);
    const teamFile = readFileSync(join(team, "pets.json"), "utf8");
    try {
      engine.annotateRecipe("pets", { pets__list_pets: { name: "all_pets" } });
      assert.equal(engine.store.isTeamRecipe("pets"), false);
      assert.ok(engine.tools.has("pets__all_pets"));
      assert.equal(readFileSync(join(team, "pets.json"), "utf8"), teamFile, "the team folder is only read");
      assert.deepEqual(await engine.forget("pets"), { restoredFromTeam: true });
      assert.equal(engine.store.isTeamRecipe("pets"), true);
      assert.ok(engine.tools.has("pets__list_pets") && !engine.tools.has("pets__all_pets"));
    } finally {
      await engine.close();
    }
  });

  it("picks up recipes published after start-up", async () => {
    const engine = engineFor("carol", team);
    try {
      assert.equal(await engine.reloadRecipes(), false, "nothing changed yet");
      await publish(team, "zoo");
      assert.equal(await engine.reloadRecipes(), true);
      assert.ok(engine.tools.has("zoo__list_pets"));
      assert.equal(await engine.reloadRecipes(), false);
    } finally {
      await engine.close();
    }
  });

  it("keeps working with personal recipes when the shared folder is unavailable", async () => {
    const engine = engineFor("dave", join(root, "offline-share"));
    try {
      await engine.importFile({ name: "mine", path: PETSTORE, baseUrl: "https://pets.example/v1" });
      assert.deepEqual([...engine.recipes.keys()], ["mine"]);
      assert.equal(engine.store.isTeamRecipe("mine"), false);
    } finally {
      await engine.close();
    }
  });
});
