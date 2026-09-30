// Sanity-check scratch file — not part of the final test suite.
async function headers() {
  const slug = globalThis.__E2E_TENANT_SLUG__;
  return {
    get(key) {
      if (key === "x-tenant-slug") return slug ?? null;
      return null;
    },
  };
}
module.exports = { headers };
