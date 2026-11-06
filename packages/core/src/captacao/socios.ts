import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getCurrentTeamId } from "@crmagro/db";
import {
  FILTROS_LOCAIS_PADRAO,
  cpfParaExibir,
  cpfValido,
  mascaraDeBusca,
  mascaraValida,
  palavrasDoNome,
  type CnpjResult,
} from "@crmagro/captation";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { donoPadrao } from "../tenancy/escopo";
import { consultarCnpjDetalhado } from "./cnpj";
import { FiltroInvalido, UFS, resolverMunicipios } from "./busca-filtros";
import { MOTIVOS_DE_BUSCA_DE_PESSOA } from "./fontes-pagas";
import { enqueueCapture } from "./queue";
import { CNPJ_LOTE_MAX } from "./service";

/**
 * Aba "Por sócios" da captação por CNPJ: empresas de uma PESSOA (por CPF, ou por nome quando uma
 * fonte paga identifica quem é) e sócios de uma EMPRESA.
 *
 * Tudo cai na MESMA fila de revisão ("nada entra na base sem seu OK"). A busca de empresas por
 * sócio é a mesma busca por filtro (`coletarPorFiltro`), com o filtro de sócio ligado: a fonte
 * gratuita (Minha Receita) lista as empresas que têm um sócio com aquela máscara de CPF e o CRM Agro
 * confere o NOME antes de aceitar (a máscara serve a cerca de mil pessoas).
 *
 * LGPD: o CPF digitado serve só para tirar a máscara; não é guardado, não vai para o job, não
 * vai para o log e não é devolvido à tela. Cada rascunho diz com que confiança foi ligado à pessoa.
 */

export { CnpjInvalid, CnpjNotFound } from "@crmagro/captation";

const motivoSchema = z.enum(MOTIVOS_DE_BUSCA_DE_PESSOA);

export const buscaDeSocioSchema = z.object({
  /** CPF completo (só para tirar a máscara) OU a máscara da Receita ("***456789**"), vinda de um sócio já listado. */
  cpf: z.string().max(20).optional(),
  mascara: z.string().max(20).optional(),
  /** Nome e sobrenome da pessoa: confere o sócio achado. Sem nome, a confiança fica "baixa". */
  nome: z.string().max(120).optional(),
  uf: z.string().length(2).optional(),
  cidade: z.string().max(80).optional(),
  motivo: motivoSchema,
  soAtivas: z.boolean().default(true),
  limite: z.number().int().min(1).max(CNPJ_LOTE_MAX).default(100),
  completarContato: z.boolean().default(false),
});
export type BuscaDeSocio = z.input<typeof buscaDeSocioSchema>;

/** Pede a busca das empresas de uma pessoa. Devolve o `lote` para a tela acompanhar. */
export async function captureEmpresasDeSocio(entrada: BuscaDeSocio): Promise<{ lote: string }> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  const p = buscaDeSocioSchema.safeParse(entrada);
  if (!p.success) throw new FiltroInvalido("Confira os campos da busca.");
  const f = p.data;

  let mascara: string | null = null;
  if (f.cpf?.trim()) {
    if (!cpfValido(f.cpf)) throw new FiltroInvalido("CPF inválido. Confira os 11 dígitos.");
    mascara = mascaraDeBusca(f.cpf);
  } else if (f.mascara?.trim()) {
    if (!mascaraValida(f.mascara.trim())) throw new FiltroInvalido("CPF mascarado inválido.");
    mascara = f.mascara.trim();
  }
  if (!mascara) throw new FiltroInvalido("Informe o CPF da pessoa ou escolha um sócio da lista.");

  const nome = f.nome?.trim() || null;
  if (nome && palavrasDoNome(nome).length < 2) throw new FiltroInvalido("Informe nome e sobrenome.");
  const uf = f.uf?.trim().toUpperCase() || null;
  if (uf && !(UFS as readonly string[]).includes(uf)) throw new FiltroInvalido(`Estado "${f.uf}" inválido.`);
  const cidade = f.cidade?.trim() || null;
  if (cidade && !uf) throw new FiltroInvalido("Para buscar por cidade, escolha o estado.");
  const cid = await resolverMunicipios(cidade ? [cidade] : [], uf);

  const lote = randomUUID();
  await enqueueCapture({
    origem: "cnpj",
    modo: "filtro",
    teamId,
    lote,
    ownerId: donoPadrao(),
    limite: f.limite,
    motivo: f.motivo,
    filtros: {
      fonte: { cnaes: [], ufs: uf ? [uf] : [], municipios: cid.codigos, cnpf: [mascara] },
      // A pessoa foi procurada de propósito: empresário individual e MEI dela entram (o filtro padrão os tira).
      locais: { ...FILTROS_LOCAIS_PADRAO, soAtivas: f.soAtivas, excluirPessoa: false, socio: { mascara, nome } },
      cidades: cid.rotulos,
    },
    completarContato: f.completarContato,
    checarWhatsApp: false,
  });
  // Sem CPF, máscara nem nome no log: só o que ajuda a depurar.
  logger.info({ teamId, lote, comNome: Boolean(nome), uf, motivo: f.motivo }, "[captura] busca de empresas por sócio pedida");
  return { lote };
}

export type SocioDaEmpresa = {
  nome: string;
  qualificacao: string | null;
  faixaEtaria: string | null;
  /** "***.456.789-**", como a tela mostra. */
  cpfExibicao: string | null;
  /** A máscara da Receita, para pedir "ver empresas dele". Null quando a fonte não a trouxe. */
  mascara: string | null;
};

export type SociosDaEmpresa = {
  cnpj: string;
  razaoSocial: string | null;
  situacao: string | null;
  fonte: CnpjResult["fonte"];
  socios: SocioDaEmpresa[];
};

/** Sócios de uma empresa (nome, qualificação, faixa de idade e CPF mascarado), pelo consultor de CNPJ. */
export async function sociosDaEmpresa(cnpj: string): Promise<SociosDaEmpresa> {
  requireCan("captacao.run");
  const { resultado: r } = await consultarCnpjDetalhado(cnpj);
  return {
    cnpj: r.cnpj,
    razaoSocial: r.razaoSocial,
    situacao: r.situacao,
    fonte: r.fonte,
    socios: r.socios.map((s) => ({
      nome: s.nome,
      qualificacao: s.qualificacao,
      faixaEtaria: s.faixaEtaria ?? null,
      cpfExibicao: s.cpfMascarado ? cpfParaExibir(s.cpfMascarado) : null,
      mascara: s.cpfMascarado ?? null,
    })),
  };
}
