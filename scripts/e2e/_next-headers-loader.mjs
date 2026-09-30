const FAKE = new URL("./_fake-next-headers.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
    return { url: FAKE, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
