import { z } from "zod";
import type { Ambiente } from "../comum";
import { definirCapacidadesDeLigacao, type CapacidadesDeLigacao } from "../capacidades";
import type { DescritorDeLigacao } from "../descritor";

/**
 * Perfis do Fake de ligação.
 *
 * Cada perfil IMITA a FORMA de um candidato real: quando ele avisa, como prova a origem do aviso, o que a
 * consulta devolve, quanto tempo guarda a gravação. Serve para provar o núcleo de prova antes de existir
 * adaptador. Onde o candidato não confirma, o perfil diz `false`: na dúvida, não vale.
 *
 * Os perfis não copiam a API nem a criptografia de ninguém, e ninguém aqui liga para ninguém.
 */

export const PERFIS_DO_FAKE_DE_LIGACAO = ["so_no_fim", "ao_vivo", "sem_consulta"] as const;
export type PerfilDoFakeDeLigacao = (typeof PERFIS_DO_FAKE_DE_LIGACAO)[number];

/**
 * O que o perfil faz e a matriz de capacidades não diz (detalhes de forma do aviso). O adaptador real traduz
 * qualquer um deles para o mesmo fato neutro.
 */
export type ComportamentoDoPerfilDeLigacao = {
  /** O aviso traz um id próprio. Sem ele, o adaptador FABRICA o `idEvento` por hash das partes que identificam o fato. */
  avisoComId: boolean;
  /** O aviso repete o id da ligação no CRM Agro (`refDaLigacao`). Sem isto, a correlação é só por `providerCallId`. */
  repeteARefDaLigacao: boolean;
  /** O aviso traz a conta e a linha (o time pode sair da linha). Sem isto, o time sai da URL assinada. */
  trazALinha: boolean;
  /** O provedor informa o sha256 da gravação (no aviso e na entrega do arquivo). */
  informaOHash: boolean;
};

type PerfilCompleto = { capacidades: CapacidadesDeLigacao; comportamento: ComportamentoDoPerfilDeLigacao };

const PERFIS: Record<PerfilDoFakeDeLigacao, PerfilCompleto> = {
  // Forma da API4COM: só avisa o fim, o aviso vai por URL assinada por conta (sem assinatura própria), a
  // consulta é limitada a 15 por minuto e não diz se atendeu, o aviso traz destino e origem, e a gravação
  // chega por webhook sem prazo declarado.
  so_no_fim: {
    capacidades: {
      originar: ["navegador"],
      originacaoSincrona: false,
      provisionarLinha: "linha",
      consulta: { porId: true, porMinuto: 15, trazAtendimento: false },
      causaDoFimGarantida: false,
      duracaoDesdeAtendimento: false,
      eventosAoVivo: false,
      pontasNoAviso: { destino: true, origem: true },
      gravacao: { entrega: "webhook", prazoHoras: null, aviso: "crmagro", apagavel: false },
      ligaAFrio: true,
      webhook: "url_assinada",
      sandbox: false,
    },
    comportamento: { avisoComId: false, repeteARefDaLigacao: false, trazALinha: false, informaOHash: false },
  },
  // Forma da Twilio: avisa o toque, o atendimento e o fim, o aviso vem assinado pelo provedor, a consulta
  // diz se atendeu, o destino é pedido na hora (resposta síncrona) e a gravação pode ser apagada.
  ao_vivo: {
    capacidades: {
      originar: ["navegador", "ponte"],
      originacaoSincrona: true,
      provisionarLinha: "conta_e_linha",
      consulta: { porId: true, porMinuto: null, trazAtendimento: true },
      causaDoFimGarantida: true,
      duracaoDesdeAtendimento: true,
      eventosAoVivo: true,
      pontasNoAviso: { destino: true, origem: true },
      gravacao: { entrega: "webhook", prazoHoras: null, aviso: "crmagro", apagavel: true },
      ligaAFrio: true,
      webhook: "assinatura_do_provedor",
      sandbox: true,
    },
    comportamento: { avisoComId: true, repeteARefDaLigacao: true, trazALinha: true, informaOHash: true },
  },
  // Forma da Meta (WhatsApp oficial): aviso assinado pelo provedor, sem consulta, gravação de 168 h com
  // aviso dado pelo próprio provedor, e só liga para quem deu permissão.
  sem_consulta: {
    capacidades: {
      originar: ["navegador"],
      originacaoSincrona: false,
      provisionarLinha: "manual",
      consulta: { porId: false, porMinuto: null, trazAtendimento: false },
      causaDoFimGarantida: false,
      duracaoDesdeAtendimento: true,
      eventosAoVivo: true,
      pontasNoAviso: { destino: true, origem: false },
      gravacao: { entrega: "webhook", prazoHoras: 168, aviso: "provedor", apagavel: false },
      ligaAFrio: false,
      webhook: "assinatura_do_provedor",
      sandbox: false,
    },
    comportamento: { avisoComId: true, repeteARefDaLigacao: true, trazALinha: true, informaOHash: true },
  },
};

/** A matriz de um perfil, já validada e congelada. */
export function capacidadesDoPerfilDeLigacao(perfil: PerfilDoFakeDeLigacao): Readonly<CapacidadesDeLigacao> {
  return definirCapacidadesDeLigacao(PERFIS[perfil].capacidades);
}

export function comportamentoDoPerfilDeLigacao(perfil: PerfilDoFakeDeLigacao): Readonly<ComportamentoDoPerfilDeLigacao> {
  return Object.freeze({ ...PERFIS[perfil].comportamento });
}

/** Prefixos da chave do Fake por ambiente (exercita a regra "chave de um ambiente não vale no outro"). */
export const PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO = { teste: "fake_teste_", producao: "fake_prod_" } as const;

/** O ramal do Fake: 3 a 8 dígitos. */
const RamalSchema = z.string().regex(/^\d{3,8}$/);

/** O descritor do Fake. O modo do webhook e o ambiente de teste acompanham a matriz (registro e suíte conferem). */
export function descritorDoFakeDeLigacao(perfil: PerfilDoFakeDeLigacao, chave = "fake_ligacao", capacidades?: CapacidadesDeLigacao): DescritorDeLigacao {
  const cap = capacidades ?? capacidadesDoPerfilDeLigacao(perfil);
  const ambientes: Ambiente[] = cap.sandbox ? ["teste"] : ["producao"];
  return {
    chave,
    nome: `Provedor de ligação de teste (perfil ${perfil})`,
    ambientes,
    campos: [
      {
        chave: "apiKey",
        rotulo: "Chave de API",
        ajuda: "Qualquer texto de 16 caracteres ou mais que comece com fake_teste_ (ou fake_prod_, no ambiente de produção). Não é uma chave de verdade.",
        escopo: "conta",
        obrigatorio: true,
        secreto: true,
        schema: z.string().min(16).max(200),
        prefixoPorAmbiente: Object.fromEntries(ambientes.map((a) => [a, [PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO[a]]])),
      },
      {
        chave: "ramal",
        rotulo: "Ramal",
        ajuda: "Um número de 3 a 8 dígitos. Qualquer um serve no provedor de teste.",
        escopo: "linha",
        obrigatorio: true,
        secreto: false,
        schema: RamalSchema,
      },
    ],
    // Na URL assinada quem prova a origem é o endereço, assinado pelo CRM Agro: não há segredo do provedor.
    segredoDoWebhook:
      cap.webhook === "assinatura_do_provedor"
        ? {
            rotulo: "Segredo do aviso",
            ajuda: "Qualquer texto com ao menos 16 caracteres. O Fake assina os avisos com ele.",
            obrigatorio: true,
            schema: z.string().min(16).max(200),
          }
        : null,
    webhook: {
      modo: cap.webhook,
      instrucao: "Não há nada para cadastrar: o Fake gera os avisos dentro do próprio teste.",
      eventosNecessarios: ["chamando", "atendida", "fim", "gravação pronta"],
    },
    testeDeConexao: "Confere a chave e não liga para ninguém.",
    avisosDeSetup: ["Provedor só para teste. Nunca liga para ninguém."],
    urlDaDocumentacao: "https://example.com/docs/provedor-de-ligacao-de-teste",
  };
}
