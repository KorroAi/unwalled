// Persistence of recipes (shareable, no secrets) and secrets (local only, never in recipes).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

export const RECIPE_SCHEMA_VERSION = 1;
export const RECIPE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** @param {string} name */
export function assertRecipeName(name) {
  if (typeof name !== "string" || !RECIPE_NAME.test(name)) {
    throw new Error(`Invalid recipe name "${name}": use 1-31 lowercase letters, digits or dashes, starting with a letter.`);
  }
}

/** Atomic JSON write (write to a temp file, then rename). */
function writeJson(file, data, secret = false) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: secret ? 0o600 : 0o644 });
  renameSync(tmp, file);
  if (secret && process.platform !== "win32") chmodSync(file, 0o600);
}

export class Store {
  /** @param {import("./config.js").Config} config */
  constructor(config) {
    this.config = config;
    for (const dir of [config.recipesDir, config.profilesDir, config.secretsDir, config.stateDir]) mkdirSync(dir, { recursive: true });
  }

  /** @param {string} name */
  profileDir(name) {
    assertRecipeName(name);
    return join(this.config.profilesDir, name);
  }

  /** @returns {Map<string, any>} */
  loadRecipes() {
    const recipes = new Map();
    for (const file of readdirSync(this.config.recipesDir).filter((f) => f.endsWith(".json"))) {
      try {
        const recipe = JSON.parse(readFileSync(join(this.config.recipesDir, file), "utf8"));
        if (recipe.schemaVersion !== RECIPE_SCHEMA_VERSION || !RECIPE_NAME.test(recipe.name) || `${recipe.name}.json` !== file) {
          log(`Skipping ${file}: unsupported or inconsistent recipe (rediscover it).`);
          continue;
        }
        recipes.set(recipe.name, recipe);
      } catch (error) {
        log(`Skipping ${file}: ${error.message}`);
      }
    }
    return recipes;
  }

  saveRecipe(recipe) {
    assertRecipeName(recipe.name);
    writeJson(join(this.config.recipesDir, `${recipe.name}.json`), recipe);
  }

  /** @param {string} name @param {{ profile?: boolean }} [options] */
  deleteRecipe(name, { profile = false } = {}) {
    assertRecipeName(name);
    rmSync(join(this.config.recipesDir, `${name}.json`), { force: true });
    rmSync(join(this.config.secretsDir, `${name}.json`), { force: true });
    rmSync(join(this.config.stateDir, `${name}.json`), { force: true });
    if (profile) rmSync(this.profileDir(name), { recursive: true, force: true });
  }

  /**
   * Secrets are request headers (Authorization, API keys, ...) keyed by host,
   * so a token captured for one host is never sent to another.
   * @param {string} name @returns {Record<string, Record<string, string>>}
   */
  loadSecrets(name) {
    assertRecipeName(name);
    const file = join(this.config.secretsDir, `${name}.json`);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }

  /** @param {string} name @param {Record<string, Record<string, string>>} secrets */
  saveSecrets(name, secrets) {
    assertRecipeName(name);
    const file = join(this.config.secretsDir, `${name}.json`);
    const hosts = Object.entries(secrets).filter(([, headers]) => Object.keys(headers).length);
    if (!hosts.length) rmSync(file, { force: true });
    else writeJson(file, Object.fromEntries(hosts), true);
  }

  /**
   * Local state of a recipe: policy, original discovery inputs (which may contain secrets), health results.
   * @param {string} name @returns {{ policy?: import("./safety.js").Policy, discovery?: any, extraDiscoveries?: any[], health?: any, headers?: Record<string, string> }}
   */
  loadState(name) {
    assertRecipeName(name);
    const file = join(this.config.stateDir, `${name}.json`);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }

  /** @param {string} name @param {(state: any) => any} update */
  updateState(name, update) {
    const next = update(this.loadState(name));
    writeJson(join(this.config.stateDir, `${name}.json`), next, true);
    return next;
  }
}
