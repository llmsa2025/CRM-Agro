import type { CapacidadesDeLigacao } from "../capacidades";
import { CredencialInvalidaDeLigacao } from "../erros";
import type { ContextoDaLigacao, MotivoDeRecusaDoAvisoDeLigacao, ProvedorDeLigacao } from "../interface";
import type { CenarioDeContratoDeLigacao } from "./tipos";

/**
 * Adaptadores DEFEITUOSOS de propósito, para provar que a suíte de contrato REPROVA o que tem de reprovar
 * Só os
 * testes da própria suíte usam.
 */

function envolver(p: ProvedorDeLigacao, sobrescrever: Partial<Record<string | symbol, unknown>>): ProvedorDeLigacao {
  return new Proxy(p, {
    get(alvo, prop) {
      if (prop in sobrescrever) return sobrescrever[prop];
      const v = Reflect.get(alvo, prop, alvo) as unknown;
      // Os métodos rodam sobre o alvo de verdade (o estado do Fake mora nele).
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
    },
  });
}

const comProvedor = (c: CenarioDeContratoDeLigacao, sufixo: string, provedor: ProvedorDeLigacao): CenarioDeContratoDeLigacao => ({ ...c, nome: `${c.nome} (${sufixo})`, provedor });

/** A matriz DECLARA coisa diferente do que o adaptador faz (mente para mais ou para menos). */
export function comMatrizTrocada(c: CenarioDeContratoDeLigacao, troca: Partial<CapacidadesDeLigacao>): CenarioDeContratoDeLigacao {
  const mentirosa = { ...c.provedor.capacidades, ...troca } as CapacidadesDeLigacao;
  return comProvedor(c, "matriz trocada", envolver(c.provedor, { capacidades: mentirosa }));
}

/** Vazamento 1: erro CRU (não neutro) com a chave no texto, como um `throw new Error(respostaDoProvedor)`. */
export function queVazaAChaveNoTextoDoErro(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  const chave = c.segredos[0]!;
  return comProvedor(
    c,
    "vaza no texto",
    envolver(c.provedor, {
      testarConexao: async (ctx: ContextoDaLigacao) => {
        if (ctx.credenciais.apiKey !== c.ctx.credenciais.apiKey) throw new Error(`401 do provedor: a chave ${chave} não foi aceita`);
        return c.provedor.testarConexao(ctx);
      },
    }),
  );
}

/** Vazamento 2: erro neutro de verdade, mas com um campo extra carregando a chave (vai para o log se alguém serializar). */
export function queVazaAChaveEmCampoExtra(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  const chave = c.segredos[0]!;
  return comProvedor(
    c,
    "vaza em campo extra",
    envolver(c.provedor, {
      testarConexao: async (ctx: ContextoDaLigacao) => {
        if (ctx.credenciais.apiKey !== c.ctx.credenciais.apiKey) {
          throw Object.assign(new CredencialInvalidaDeLigacao(c.provedor.chave), { detalheDoProvedor: `Authorization: Bearer ${chave}` });
        }
        return c.provedor.testarConexao(ctx);
      },
    }),
  );
}

/** Vazamento 3: a verificação do aviso devolve o segredo no `motivo`. */
export function queVazaOSegredoNaVerificacaoDoWebhook(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  const segredo = c.segredos[c.segredos.length - 1]!;
  return comProvedor(
    c,
    "vaza no webhook",
    envolver(c.provedor, {
      verificarWebhook: () => ({ autentico: false, motivo: `assinatura diferente do esperado ${segredo}` as unknown as MotivoDeRecusaDoAvisoDeLigacao }),
    }),
  );
}

/** Um erro que NÃO é neutro escapa de um método (o texto do provedor chega ao resto do CRM Agro). */
export function queDeixaEscaparErroDoProvedor(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  return comProvedor(
    c,
    "erro escapa",
    envolver(c.provedor, {
      encerrar: async (ctx: ContextoDaLigacao, id: string) => {
        if (id === "pc_que_nao_existe") throw new Error("Contato João da Silva, telefone 11 98888-7777, não encontrado");
        return c.provedor.encerrar(ctx, id);
      },
    }),
  );
}

/** A verificação aceita QUALQUER aviso (adulterado, sem assinatura, sem segredo). Na URL assinada, aceita o que não podia provar. */
export function queAceitaQualquerAviso(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  return comProvedor(c, "aceita qualquer aviso", envolver(c.provedor, { verificarWebhook: () => ({ autentico: true }) }));
}

/** Defeito 1 do F1B-04: põe o telefone do contato no fato (num campo que o schema `.strict()` não admite). */
export function queBotaTelefoneNoFato(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  return comProvedor(
    c,
    "telefone no fato",
    envolver(c.provedor, {
      normalizarWebhook: (corpo: unknown) => {
        const r = c.provedor.normalizarWebhook(corpo);
        const telefone = r.pontas.find((p) => p.destinoE164)?.destinoE164 ?? (corpo as { destino?: string } | null)?.destino ?? "+5511999990000";
        return { ...r, fatos: r.fatos.map((f) => ({ ...f, telefone })) };
      },
    }),
  );
}

/** Defeito 2 do F1B-04: o `idEvento` muda a cada normalização (o mesmo aviso nunca deduplica). */
export function cujoIdEventoMudaACadaNormalizacao(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  let n = 0;
  return comProvedor(
    c,
    "idEvento instável",
    envolver(c.provedor, {
      normalizarWebhook: (corpo: unknown) => {
        const r = c.provedor.normalizarWebhook(corpo);
        n += 1;
        return {
          ...r,
          fatos: r.fatos.map((f) => ({ ...f, idEvento: `${f.idEvento}-${n}` })),
          pontas: r.pontas.map((p) => ({ ...p, idEvento: `${p.idEvento}-${n}` })),
        };
      },
    }),
  );
}

/** Defeito 3 do F1B-04: a matriz declara pontas no aviso, mas o adaptador não as manda. */
export function queDeclaraPontasENaoAsManda(c: CenarioDeContratoDeLigacao): CenarioDeContratoDeLigacao {
  return comProvedor(
    c,
    "pontas que não vêm",
    envolver(c.provedor, {
      normalizarWebhook: (corpo: unknown) => ({ ...c.provedor.normalizarWebhook(corpo), pontas: [] }),
    }),
  );
}
