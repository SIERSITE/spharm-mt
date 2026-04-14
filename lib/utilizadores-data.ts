import "server-only";
import { getPrisma } from "@/lib/prisma";

export type UtilizadorListRow = {
  id: string;
  email: string;
  nome: string;
  perfil: "ADMINISTRADOR" | "GESTOR_GRUPO" | "GESTOR_FARMACIA" | "OPERADOR";
  estado: "ATIVO" | "INATIVO";
  farmaciaPrimaria: string | null;
  farmaciasExtra: string[];
  ultimoLogin: Date | null;
  mustChangePassword: boolean;
  dataCriacao: Date;
};

export async function listUtilizadores(): Promise<UtilizadorListRow[]> {
  const prisma = await getPrisma();
  const users = await prisma.utilizador.findMany({
    select: {
      id: true,
      email: true,
      nome: true,
      perfil: true,
      estado: true,
      ultimoLogin: true,
      mustChangePassword: true,
      dataCriacao: true,
      farmacia: { select: { nome: true } },
      farmacias: {
        select: { farmacia: { select: { nome: true } } },
      },
    },
    orderBy: [{ estado: "asc" }, { nome: "asc" }],
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    nome: u.nome,
    perfil: u.perfil,
    estado: u.estado,
    farmaciaPrimaria: u.farmacia?.nome ?? null,
    farmaciasExtra: u.farmacias.map((x) => x.farmacia.nome),
    ultimoLogin: u.ultimoLogin,
    mustChangePassword: u.mustChangePassword,
    dataCriacao: u.dataCriacao,
  }));
}

export async function getUtilizador(id: string) {
  const prisma = await getPrisma();
  return prisma.utilizador.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      nome: true,
      perfil: true,
      estado: true,
      farmaciaId: true,
      mustChangePassword: true,
      ultimoLogin: true,
      dataCriacao: true,
      farmacias: { select: { farmaciaId: true } },
    },
  });
}
