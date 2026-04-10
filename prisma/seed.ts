import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const passwordHash = await bcrypt.hash("Admin1234", 10);

  const farmaciaPrincipal = await prisma.farmacia.upsert({
    where: { nome: "Farmácia Principal" },
    update: {},
    create: {
      nome: "Farmácia Principal",
      codigoANF: "PRINCIPAL001",
    },
  });

  const farmaciaCastelo = await prisma.farmacia.upsert({
    where: { nome: "Farmácia Castelo" },
    update: {},
    create: {
      nome: "Farmácia Castelo",
      codigoANF: "CASTELO001",
    },
  });

  await prisma.utilizador.upsert({
    where: { email: "admin@spharmmt.local" },
    update: {},
    create: {
      nome: "Administrador",
      email: "admin@spharmmt.local",
      perfil: "ADMINISTRADOR",
      estado: "ATIVO",
      passwordHash,
    },
  });

  console.log("Seed executado com sucesso.");
  console.log("Farmácias criadas:", farmaciaPrincipal.nome, "e", farmaciaCastelo.nome);
  console.log("Utilizador admin: admin@spharmmt.local");
  console.log("Password: Admin1234");
}

main()
  .catch((e) => {
    console.error("Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });