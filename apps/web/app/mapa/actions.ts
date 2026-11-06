"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { acaoDaTela } from "@/lib/tenant";
import {
  cidadeDoPonto,
  create,
  definirLocalizacaoManual,
  listCamadas,
  createCamada,
  updateCamada,
  deleteCamada,
  moverContatosParaCamada,
  contatoNoMapa,
  CORES_CAMADA,
  areaHaField,
  faturamentoAnualField,
  type CamadaDTO,
  type ContatoNoMapaDTO,
} from "@crmagro/core";


/**
 * Telas por pessoa (F2b): toda action deste arquivo confere a tela "mapa". As
 * ações de contato do mapa (camadas, posição, criar contato) valem para quem
 * tem o Mapa, mesmo sem a tela Contatos (exceção do dono, 28/09).
 */
const runAsUserAction = acaoDaTela("mapa", { tambem: ["contatos"] });
/** Mensagem do erro sem o prefixo do nome ("CamadaJaExiste: já existe…" → "já existe…"). */
const mensagem = (e: unknown) => (e instanceof Error ? e.message.replace(/^[A-Za-z]+: /, "") : String(e));

/**
 * Criar contato a partir de um ponto do mapa (botão direito → "Criar contato
 * aqui"). Cidade/UF vêm da geocodificação reversa do ponto quando disponível;
 * a posição é gravada como MANUAL (o backfill nunca a sobrescreve). Área,
 * faturamento e camada são opcionais.
 */
const schema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório").max(120),
  telefone: z.string().trim().max(40).optional(),
  email: z.string().trim().email("e-mail inválido").max(200).optional(),
  empresa: z.string().trim().max(120).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Texto como a pessoa digitou ("1.250"): os mesmos campos do schema do contato.
  areaHa: areaHaField,
  faturamentoAnual: faturamentoAnualField,
  camadaId: z.string().uuid().optional(),
});

export type ContatoCriadoNoMapa = {
  id: string;
  nome: string;
  empresa: string | null;
  cidade: string | null;
  estado: string | null;
  camadaId: string | null;
};
export type CriarNoMapaState = { ok: true; contact: ContatoCriadoNoMapa } | { ok: false; error: string };

export async function createContactFromMapAction(input: unknown): Promise<CriarNoMapaState> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const d = parsed.data;
  try {
    const contact = await runAsUserAction(async () => {
      // Camada inválida recusa ANTES de criar (não sobra contato criado pela metade).
      if (d.camadaId && !(await listCamadas()).camadas.some((c) => c.id === d.camadaId)) throw new Error("camada não encontrada");
      const lugar = await cidadeDoPonto({ latitude: d.latitude, longitude: d.longitude });
      const novo = await create({
        nome: d.nome,
        telefone: d.telefone || undefined,
        email: d.email || undefined,
        empresa: d.empresa || undefined,
        cidade: lugar?.cidade ?? undefined,
        estado: lugar?.estado ?? undefined,
        origem: "mapa",
        tags: [],
        areaHa: d.areaHa ?? undefined,
        faturamentoAnual: d.faturamentoAnual ?? undefined,
      });
      await definirLocalizacaoManual(novo.id, { latitude: d.latitude, longitude: d.longitude });
      // Camada depois de criar: `moverContatosParaCamada` confere que ela é do time.
      if (d.camadaId) await moverContatosParaCamada([novo.id], d.camadaId);
      return { id: novo.id, nome: novo.nome, empresa: novo.empresa, cidade: novo.cidade, estado: novo.estado, camadaId: d.camadaId ?? null };
    });
    revalidatePath("/contatos");
    return { ok: true, contact };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

// ---------------------------------------------------------------------------
// Camadas (estilo Google My Maps). RBAC no core: ler = time; escrever = contacts.write.
// ---------------------------------------------------------------------------

export type CamadasState = { ok: true; camadas: CamadaDTO[]; semCamada: number; cores: string[] } | { ok: false; error: string };
export type CamadaState = { ok: true; camada: CamadaDTO } | { ok: false; error: string };
export type AcaoState = { ok: true } | { ok: false; error: string };

/** Camadas do time + as cores disponíveis (o cliente não importa valor do core). */
export async function listCamadasAction(): Promise<CamadasState> {
  try {
    const r = await runAsUserAction(() => listCamadas());
    return { ok: true, ...r, cores: [...CORES_CAMADA] };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export async function createCamadaAction(input: { nome: string; cor?: string }): Promise<CamadaState> {
  try {
    return { ok: true, camada: await runAsUserAction(() => createCamada(input)) };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export async function updateCamadaAction(id: string, input: { nome?: string; cor?: string }): Promise<CamadaState> {
  try {
    return { ok: true, camada: await runAsUserAction(() => updateCamada(id, input)) };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export async function deleteCamadaAction(id: string): Promise<AcaoState> {
  try {
    await runAsUserAction(() => deleteCamada(id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

const moverSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
  camadaId: z.string().uuid().nullable(),
});

/** Move contatos para a camada (`null` = "Sem camada"). */
export async function moverContatosParaCamadaAction(
  ids: string[],
  camadaId: string | null,
): Promise<{ ok: true; movidos: number } | { ok: false; error: string }> {
  const parsed = moverSchema.safeParse({ ids, camadaId });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  try {
    const r = await runAsUserAction(() => moverContatosParaCamada(parsed.data.ids, parsed.data.camadaId));
    return { ok: true, movidos: r.movidos };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

/** Camada, área e faturamento do contato selecionado no mapa (payload do mapa fica enxuto). */
export async function getContatoResumoAction(id: string): Promise<{ ok: true; contato: ContatoNoMapaDTO | null } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "id inválido" };
  try {
    return { ok: true, contato: await runAsUserAction(() => contatoNoMapa(id)) };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}
