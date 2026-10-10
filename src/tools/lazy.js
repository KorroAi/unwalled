// Compact mode for large recipes: instead of one tool per operation (all sent to the model with every request),
// the recipe exposes "<recipe>__operation" (find an operation and read its parameters) and "<recipe>__call" (call it).

/**
 * @param {any} recipe
 * @param {import("./generate.js").GeneratedTool[]} tools fully built tools; those marked `lazy` are folded
 * @param {(suffix: string) => string} name
 * @returns {import("./generate.js").GeneratedTool[]}
 */
export function foldTools(recipe, tools, name) {
  const folded = tools.filter((t) => t.lazy);
  const kept = tools.filter((t) => !t.lazy);
  const byName = new Map(folded.map((t) => [t.name.slice(recipe.name.length + 2), t]));
  const summary = (/** @type {import("./generate.js").GeneratedTool} */ t) => t.description.replace(/^\[[^\]]+\]\s*/, "").split(/(?<=\.)\s/)[0].slice(0, 160);
  const ids = [...byName.keys()];
  return [
    ...kept,
    {
      name: name("operation"),
      description:
        `[${recipe.name}] ${folded.length} operations are available through ${recipe.name}__call (compact mode). ` +
        "Without operation: list them (optional text filter). With operation: show its description and input schema.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "Operation id, e.g. one returned by a listing." },
          filter: { type: "string", description: "Only operations whose id or description contains this text." },
        },
      },
      annotations: { title: `${recipe.name} operations`, readOnlyHint: true, openWorldHint: false },
      run: async (args) => {
        if (args.operation) {
          const tool = byName.get(String(args.operation));
          if (!tool) {
            const close = ids.filter((id) => id.toLowerCase().includes(String(args.operation).toLowerCase())).slice(0, 15);
            return { text: `Unknown operation "${args.operation}".${close.length ? ` Similar: ${close.join(", ")}` : ""}`, isError: true };
          }
          const hints = [tool.annotations.readOnlyHint ? "read-only" : "may change data", tool.annotations.destructiveHint ? "destructive" : ""].filter(Boolean).join(", ");
          return { text: `${tool.description}\n(${hints})\nArguments (pass them as "arguments" to ${recipe.name}__call):\n${JSON.stringify(tool.inputSchema)}`, isError: false };
        }
        const needle = String(args.filter ?? "").toLowerCase();
        const lines = [...byName].filter(([id, t]) => !needle || `${id} ${t.description}`.toLowerCase().includes(needle)).map(([id, t]) => `${id} — ${summary(t)}`);
        return { text: lines.length ? lines.join("\n") : "No operation matches.", isError: false };
      },
    },
    {
      name: name("call"),
      description: `[${recipe.name}] Call one of the ${folded.length} operations listed by ${recipe.name}__operation, with the arguments its schema describes.`,
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "Operation id." },
          arguments: { type: "object", additionalProperties: true, description: "Arguments as described by the operation's input schema (path, query, body, pick, paginate...)." },
        },
        required: ["operation"],
      },
      // The folded operations may write: the agent sees the per-operation hints through __operation.
      annotations: { title: `${recipe.name} call`, readOnlyHint: false, destructiveHint: folded.some((t) => t.annotations.destructiveHint), openWorldHint: true },
      run: async (args) => {
        const tool = byName.get(String(args.operation));
        if (!tool) return { text: `Unknown operation "${args.operation}". Call ${recipe.name}__operation to list them.`, isError: true };
        return tool.run(args.arguments ?? {});
      },
    },
  ];
}
