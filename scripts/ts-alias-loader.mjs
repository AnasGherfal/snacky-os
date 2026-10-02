import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const relative = specifier.slice(2);
    const withExtension = path.extname(relative) ? relative : `${relative}.ts`;
    return {
      url: pathToFileURL(path.join(repoRoot, "src", withExtension)).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
