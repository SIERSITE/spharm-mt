import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const p = await getTenantPrismaOrLegacy(slug);
  const med = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };
  const [total, semATC, semDCI, semForma, semDose, semEmb, semImg, comTudo] = await Promise.all([
    p.produto.count({ where: med }),
    p.produto.count({ where: { ...med, codigoATC: null } }),
    p.produto.count({ where: { ...med, dci: null } }),
    p.produto.count({ where: { ...med, formaFarmaceutica: null } }),
    p.produto.count({ where: { ...med, dosagem: null } }),
    p.produto.count({ where: { ...med, embalagem: null } }),
    p.produto.count({ where: { ...med, imagemUrl: null } }),
    p.produto.count({ where: { ...med, codigoATC: { not: null }, dci: { not: null }, formaFarmaceutica: { not: null }, dosagem: { not: null }, embalagem: { not: null } } }),
  ]);
  console.log(`${slug}: total=${total} semATC=${semATC} semDCI=${semDCI} semForma=${semForma} semDose=${semDose} semEmb=${semEmb} semImg=${semImg} completos=${comTudo} (${((comTudo/total)*100).toFixed(1)}%)`);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
