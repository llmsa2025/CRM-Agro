/**
 * Zod das RESPOSTAS do Nectar (fonte de verdade dos tipos lidos). Ficha N1. Os
 * schemas de contato, oportunidade, qualificação e nota (N3) são TOLERANTES de
 * propósito: a forma exata é "a homologar", e o N20 aperta depois da conta de
 * teste. Não "aperte" por palpite.
 *
 * Todo objeto usa o `strip` padrão do zod (chave desconhecida é jogada fora) e
 * NUNCA `.passthrough()`: é o `strip` que descarta `sipPassword`, `listaIps` e
 * `restricaoPorIp` do usuário antes de a resposta chegar ao DTO, ao log ou ao
 * cache (plano §2.2, "Só os campos que o CRM Agro usa").
 *
 * Regra da pasta `providers/nectarcrm/`: só importa `zod`, tipos e `node:crypto`.
 */
import { z } from "zod";

/** Id do Nectar é opaco: chega como número ou texto e vira SEMPRE string (nunca Number: id grande perde precisão). */
export const idNectar = z.union([z.number(), z.string()]).transform(String);

/** Booleano que a API às vezes documenta como texto (campo `obrigatorio` do campo personalizado). */
const booleanoTolerante = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true");

export const usuarioSchema = z.object({
  id: idNectar,
  nome: z.string(),
  email: z.string().nullish(),
  login: z.string().nullish(),
  ativo: z.boolean().default(true),
  // Usuário de outro sistema / da equipe de suporte do Nectar: o CRM Agro esconde.
  virtual: z.boolean().optional(),
  isSuporte: z.boolean().optional(),
});
export type UsuarioNectar = z.infer<typeof usuarioSchema>;

export const etapaSchema = z.object({
  id: idNectar,
  nome: z.string(),
  sequencia: z.number().default(0),
});

export const pipelineSchema = z.object({
  id: idNectar,
  nome: z.string(),
  tipo: z.number().nullish(),
  ativo: z.boolean().default(true),
  padrao: z.boolean().default(false),
  sequencias: z.array(etapaSchema).default([]),
  iniciarQualquerEtapa: z.boolean().default(true),
  produtoObrigatorio: z.boolean().default(false),
  // 0 = B2B, 1 = B2C (README do funil).
  modeloVenda: z.number().default(0),
});
export type PipelineNectar = z.infer<typeof pipelineSchema>;

export const queueSchema = z.object({ id: idNectar, name: z.string() });

export const listaSchema = z.object({
  id: idNectar,
  nome: z.string(),
  ativo: z.boolean().default(true),
  // 0 = contato, 1 = oportunidade, 2 = ambos.
  relacionada: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullish(),
  podeIncluir: z.boolean().default(true),
});

export const campoPersonalizadoSchema = z.object({
  id: idNectar,
  nome: z.string(),
  tipo: z.number().nullish(),
  obrigatorio: booleanoTolerante.default(false),
});

/** Serve só para CONTAR formatos de telefone. O número nunca sai da função que o lê. */
export const contatoAmostraSchema = z.object({
  id: idNectar,
  telefones: z.array(z.union([z.string(), z.object({ numero: z.string() })])).default([]),
});

export const usuariosSchema = z.array(usuarioSchema);
export const pipelinesSchema = z.array(pipelineSchema);
export const queuesSchema = z.array(queueSchema);
export const listasSchema = z.array(listaSchema);
export const camposPersonalizadosSchema = z.array(campoPersonalizadoSchema);
export const contatosAmostraSchema = z.array(contatoAmostraSchema);

// ─── Contato, oportunidade, qualificação e nota (ficha N3) ──────────────────

/** Texto que a API às vezes manda como número (ex.: `codigo`). */
const textoOuNumero = z.union([z.string(), z.number()]).transform(String);

/** Contato lido do Nectar, já no formato que o CRM Agro usa (`ContatoRemoto`). */
export const contatoRemotoSchema = z
  .object({
    id: idNectar,
    nome: z.string().nullish(),
    emails: z.array(z.union([z.string(), z.object({ email: z.string() })])).nullish(),
    telefones: z.array(z.union([z.string(), z.object({ numero: z.string() })])).nullish(),
    listas: z.array(z.union([z.string(), z.object({ nome: z.string() })])).nullish(),
    codigo: textoOuNumero.nullish(),
    constante: z.number().nullish(),
    empresaAtual: z.object({ id: idNectar }).nullish(),
    cargo: z.string().nullish(),
    blocked: z.boolean().nullish(),
  })
  .transform((c) => ({
    id: c.id,
    nome: c.nome ?? null,
    emails: (c.emails ?? []).map((e) => (typeof e === "string" ? e : e.email)),
    telefones: (c.telefones ?? []).map((t) => (typeof t === "string" ? t : t.numero)),
    listas: (c.listas ?? []).map((l) => (typeof l === "string" ? l : l.nome)),
    codigo: c.codigo ?? null,
    constante: c.constante ?? null,
    empresaAtualId: c.empresaAtual?.id ?? null,
    cargo: c.cargo ?? null,
    blocked: c.blocked ?? false,
  }));

/** A busca devolve um objeto ou uma lista, conforme a rota: sempre vira lista. */
export const contatosRemotosSchema = z
  .union([z.array(contatoRemotoSchema), contatoRemotoSchema])
  .transform((v) => (Array.isArray(v) ? v : [v]));

/** Funil da oportunidade ou da qualificação: objeto com `id` (o `{}` do exemplo oficial fica sem id). */
const funilRefSchema = z.object({ id: idNectar.optional(), nome: z.string().optional() }).nullish();

export const oportunidadeRemotaSchema = z
  .object({
    id: idNectar,
    nome: z.string().nullish(),
    status: z.number().nullish(),
    funilVenda: funilRefSchema,
    pipeline: funilRefSchema,
  })
  .transform((o) => ({
    id: o.id,
    nome: o.nome ?? "",
    status: o.status ?? null,
    funilId: o.funilVenda?.id ?? o.pipeline?.id ?? null,
  }));
export const oportunidadesRemotasSchema = z.array(oportunidadeRemotaSchema);

export const qualificacaoRemotaSchema = z
  .object({
    id: idNectar,
    status: z.number().nullish(),
    funilVenda: funilRefSchema,
    pipeline: funilRefSchema,
  })
  .transform((q) => ({ id: q.id, status: q.status ?? null, funilId: q.funilVenda?.id ?? q.pipeline?.id ?? null }));
export const qualificacoesRemotasSchema = z.array(qualificacaoRemotaSchema);

/** Uma nota da lista geral (`GET /publicacao/`): a data de criação é o que a procura do marcador precisa. */
export const publicacaoSchema = z.object({
  id: idNectar,
  dataCriacao: z.string(),
  descricao: z.string().nullish(),
  assunto: z.string().nullish(),
});
export const publicacoesSchema = z.array(publicacaoSchema);

/** Resposta de criação: só o id importa. */
export const refSchema = z.object({ id: idNectar });
