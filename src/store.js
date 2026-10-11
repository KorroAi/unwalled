// Persistence of recipes (shareable, no secrets) and secrets (local only, never in recipes).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptJson, encryptJson, isEncrypted, secretKey } from "./crypto.js";
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

/** @param {string} dir @returns {Map<string, any>} */
function readRecipeDir(dir) {
  const recipes = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const recipe = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (recipe.schemaVersion !== RECIPE_SCHEMA_VERSION || !RECIPE_NAME.test(recipe.name) || `${recipe.name}.json` !== file) {
        log(`Skipping ${join(dir, file)}: unsupported or inconsistent recipe (rediscover it).`);
        continue;
      }
      recipes.set(recipe.name, recipe);
    } catch (error) {
      log(`Skipping ${join(dir, file)}: ${error.message}`);
    }
  }
  return recipes;
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

  /**
   * Personal recipes, on top of the team catalogue (UNWALLED_TEAM_RECIPES) when there is one: a personal recipe with the
   * same name replaces the team's. Team recipes are only read; changing one (annotations, macros) saves a personal copy.
   * @returns {Map<string, any>}
   */
  loadRecipes() {
    /** Names of the recipes currently served from the team catalogue. @type {Set<string>} */
    this.teamNames = new Set();
    const team = this.loadTeamRecipes();
    for (const name of team.keys()) this.teamNames.add(name);
    const recipes = new Map(team);
    for (const [name, recipe] of readRecipeDir(this.config.recipesDir)) {
      recipes.set(name, recipe);
      this.teamNames.delete(name);
    }
    return recipes;
  }

  /** Recipes of the team catalogue (empty when there is none or it cannot be read). @returns {Map<string, any>} */
  loadTeamRecipes() {
    const dir = this.config.teamRecipesDir;
    if (!dir) return new Map();
    if (!existsSync(dir)) {
      log(`Team recipes folder ${dir} not found: only personal recipes are loaded.`);
      return new Map();
    }
    return readRecipeDir(dir);
  }

  /** @param {string} name */
  isTeamRecipe(name) {
    return !!this.teamNames?.has(name);
  }

  saveRecipe(recipe) {
    assertRecipeName(recipe.name);
    writeJson(join(this.config.recipesDir, `${recipe.name}.json`), recipe);
    this.teamNames?.delete(recipe.name);
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
    let stored;
    try {
      stored = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
    if (isEncrypted(stored)) {
      try {
        return decryptJson(stored, secretKey(this.config.home).key);
      } catch (error) {
        log(`Cannot decrypt the secrets of "${name}" (${error.message}): wrong UNWALLED_SECRET_KEY or another user? Sign in again or set credentials.`);
        return {};
      }
    }
    // Secrets written by an older version (or with encryption off) are re-encrypted on first read.
    if (this.config.encryptSecrets && Object.keys(stored).length) this.saveSecrets(name, stored);
    return stored;
  }

  /** @param {string} name @param {Record<string, Record<string, string>>} secrets */
  saveSecrets(name, secrets) {
    assertRecipeName(name);
    const file = join(this.config.secretsDir, `${name}.json`);
    const hosts = Object.entries(secrets).filter(([, headers]) => Object.keys(headers).length);
    if (!hosts.length) rmSync(file, { force: true });
    else {
      const plain = Object.fromEntries(hosts);
      writeJson(file, this.config.encryptSecrets ? encryptJson(plain, secretKey(this.config.home).key) : plain, true);
    }
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
      const stored = JSON.parse(readFileSync(file, "utf8"));
      return isEncrypted(stored) ? decryptJson(stored, secretKey(this.config.home).key) : stored;
    } catch (error) {
      log(`Cannot read the local state of "${name}" (${/** @type {Error} */ (error).message}): starting from an empty state.`);
      return {};
    }
  }

  /**
   * The state holds the discovery inputs, sign-in steps and their typed passwords included: encrypted like the secrets.
   * @param {string} name @param {(state: any) => any} update
   */
  updateState(name, update) {
    const next = update(this.loadState(name));
    writeJson(join(this.config.stateDir, `${name}.json`), this.config.encryptSecrets ? encryptJson(next, secretKey(this.config.home).key) : next, true);
    return next;
  }
}
