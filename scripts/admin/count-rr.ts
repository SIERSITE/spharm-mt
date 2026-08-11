import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
async function main() {
  for (const slug of ["grupo-silveira", "demo-neon", "piloto-demo"]) {
    const p = await getTenantPrismaOrLegacy(slug);
    const total = await p.regulatoryRecord.count();
    const withATC = await p.regulatoryRecord.count({ where: { codigoATC: { not: null } } });
    const withDCI = await p.regulatoryRecord.count({ where: { dci: { not: null } } });
    console.log(`  ${slug.padEnd(25)} RegulatoryRecord: total=${total}  ATC=${withATC}  DCI=${withDCI}`);
    await p.$disconnect();
  }
  // Também na legacy
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const legacy = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const totalL = await legacy.regulatoryRecord.count();
  const atcL = await legacy.regulatoryRecord.count({ where: { codigoATC: { not: null } } });
  console.log(`  ${"neondb (legacy)".padEnd(25)} RegulatoryRecord: total=${totalL}  ATC=${atcL}`);
  await legacy.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
