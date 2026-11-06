import { beforeEach, describe, expect, it } from "vitest";
import { MODOS_DE_ORIGINAR_DE_LIGACAO } from "../capacidades";
import { problemasDoDescritorDeLigacao } from "../descritor";
import { ErroDeLigacao, NaoEncontradoDeLigacao, NaoSuportadoDeLigacao } from "../erros";
import { problemasDoRegistroDeLigacao, flagDoProvedorDeLigacao } from "../registro";
import { erroDe, fatosDosAvisos, ligarEConduzir, ligarParaTeste, normalizarAviso } from "./cenas";
import type { CenarioDeContratoDeLigacao, FabricaDeCenarioDeLigacao } from "./tipos";
import {
  conferirAutenticacaoDoAviso,
  conferirErrosNeutros,
  conferirFatos,
  conferirGravacao,
  conferirHonestidadeDaMatriz,
  conferirIdEventoEstavel,
  conferirPontas,
  conferirSigilo,
} from "./verificacoes";

/**
 * A SUÍTE DE CONTRATO `contratoDeProvedorDeLigacao`.
 *
 * TODO adaptador de ligação precisa passá-la. É a prova de que "adicionar um provedor" é só escrever o
 * adaptador, o descritor e a matriz. Roda:
 * - sempre contra o Fake de ligação (todos os perfis);
 * - nas fichas dos adaptadores (F2 e F4), contra o adaptador real com RESPOSTAS GRAVADAS (a chamada HTTP é
 *   trocada por uma função em memória: nada de rede no CI);
 * - quando há credencial de teste, contra o provedor real, por um script que o dono roda, NUNCA o agente nem o CI.
 *
 * Uso (em um arquivo `*.test.ts`):
 *   contratoDeProvedorDeLigacao("meu-provedor", () => cenarioDoMeuProvedor());
 *
 * Grupos: conexão, originar, encerrar, webhook, consulta, gravação, erros neutros, honestidade da matriz e sigilo.
 */
export function contratoDeProvedorDeLigacao(nome: string, fabrica: FabricaDeCenarioDeLigacao): void {
  // A fábrica é chamada uma vez na coleta (para ler a matriz) e de novo em cada teste (estado limpo).
  const amostra = fabrica();
  if (amostra instanceof Promise) throw new Error("contratoDeProvedorDeLigacao: a fábrica de cenário precisa ser síncrona (a preparação assíncrona fica no roteiro).");
  const cap = amostra.provedor.capacidades;

  describe(`contrato de provedor de ligação: ${nome}`, () => {
    let c: CenarioDeContratoDeLigacao;
    beforeEach(() => {
      const novo = fabrica();
      if (novo instanceof Promise) throw new Error("A fábrica de cenário precisa ser síncrona.");
      c = novo;
    });

    describe("conexão", () => {
      it("a chave certa conecta e não liga para ninguém", async () => {
        const r = await c.provedor.testarConexao(c.ctx);
        expect(r.ok).toBe(true);
      });

      it("a chave errada lança credencial_invalida e não repete a chave", async () => {
        const e = await erroDe(() => c.provedor.testarConexao(c.ctxComCredencialErrada));
        expect(e).toBeInstanceOf(ErroDeLigacao);
        expect((e as ErroDeLigacao).codigo).toBe("credencial_invalida");
        expect(JSON.stringify(e)).not.toContain(Object.values(c.ctxComCredencialErrada.credenciais)[0]!);
      });

      it("o descritor e a matriz concordam com o adaptador (o registro o aceitaria)", () => {
        expect(problemasDoDescritorDeLigacao(c.descritor)).toEqual([]);
        expect(c.descritor.chave).toBe(c.provedor.chave);
        expect(
          problemasDoRegistroDeLigacao({
            chave: c.provedor.chave,
            rotulo: c.descritor.nome,
            capacidades: c.provedor.capacidades,
            descritor: c.descritor,
            fabrica: () => c.provedor,
            flag: flagDoProvedorDeLigacao(c.provedor.chave),
          }),
        ).toEqual([]);
      });
    });

    describe("originar", () => {
      it("cada modo declarado funciona e devolve o id da ligação; o não declarado lança nao_suportado", async () => {
        for (const modo of MODOS_DE_ORIGINAR_DE_LIGACAO) {
          const declarado = cap.originar.includes(modo);
          let providerCallId: string | undefined;
          const e = await erroDe(async () => {
            providerCallId = (await ligarParaTeste(c, { modo })).providerCallId;
            await c.provedor.encerrar(c.ctx, providerCallId);
          });
          if (declarado) {
            expect(e, `modo ${modo}`).toBeUndefined();
            expect(providerCallId, `modo ${modo}`).toBeTruthy();
          } else {
            expect(e, `modo ${modo}`).toBeInstanceOf(NaoSuportadoDeLigacao);
          }
        }
      });
    });

    describe("encerrar", () => {
      it("pede o fim de uma ligação em andamento sem erro", async () => {
        const l = await ligarParaTeste(c);
        await expect(c.provedor.encerrar(c.ctx, l.providerCallId)).resolves.toBeUndefined();
      });

      it("ligação que o provedor não conhece lança nao_encontrado", async () => {
        expect(await erroDe(() => c.provedor.encerrar(c.ctx, "pc_que_nao_existe"))).toBeInstanceOf(NaoEncontradoDeLigacao);
      });
    });

    describe("webhook", () => {
      it(`a origem do aviso é conferida (modo ${cap.webhook})`, async () => {
        expect(await conferirAutenticacaoDoAviso(c)).toEqual([]);
      });

      it("a ligação atendida vira os fatos certos, todos da mesma ligação, e termina em encerrada(atendida)", async () => {
        const l = await ligarEConduzir(c, { causa: "atendida" });
        const fatos = fatosDosAvisos(c, l.avisos);
        expect(fatos.length).toBeGreaterThan(0);
        for (const f of fatos) {
          if (f.providerCallId !== undefined) expect(f.providerCallId).toBe(l.providerCallId);
        }
        const fim = fatos.find((f) => f.tipo === "encerrada");
        expect(fim).toBeDefined();
        expect(fim && fim.tipo === "encerrada" && fim.causa).toBe("atendida");
      });

      it("a ligação que ninguém atendeu vira encerrada(nao_atendeu)", async () => {
        const l = await ligarEConduzir(c, { causa: "nao_atendeu" });
        const fim = fatosDosAvisos(c, l.avisos).find((f) => f.tipo === "encerrada");
        expect(fim && fim.tipo === "encerrada" && fim.causa).toBe("nao_atendeu");
      });

      it("os fatos cabem no schema e nunca carregam o telefone do contato", async () => {
        expect(await conferirFatos(c)).toEqual([]);
      });

      it("o mesmo aviso duas vezes dá o mesmo idEvento, e fatos diferentes dão ids diferentes", async () => {
        expect(await conferirIdEventoEstavel(c)).toEqual([]);
      });

      it("com pontasNoAviso, todo fato terminal tem a ponta declarada (e sem a declaração, não vem ponta)", async () => {
        expect(await conferirPontas(c)).toEqual([]);
      });

      it("corpo fora do formato lança em vez de virar fato", () => {
        expect(() => c.provedor.normalizarWebhook("texto solto")).toThrow();
        expect(() => c.provedor.normalizarWebhook({})).toThrow();
        expect(() => c.provedor.normalizarWebhook(null)).toThrow();
        expect(() => c.provedor.normalizarWebhook([])).toThrow();
      });

      it("evento que o CRM Agro não entende não vira fato e não lança", async () => {
        const req = await c.roteiro.avisoQueOCrmAgroNaoEntende();
        expect(normalizarAviso(c, req)).toEqual({ fatos: [], sinais: [], pontas: [] });
      });

      it.skipIf(typeof amostra.provedor.responderVerificacao !== "function")("o aperto de mão do GET devolve o desafio com o token certo e recusa o errado", () => {
        const query = c.roteiro.queryDeVerificacao;
        expect(query, "o cenário precisa de queryDeVerificacao").toBeDefined();
        expect(c.provedor.responderVerificacao!(c.ctx, query!("desafio_123", true))).toBe("desafio_123");
        expect(c.provedor.responderVerificacao!(c.ctx, query!("desafio_123", false))).toBeNull();
        expect(c.provedor.responderVerificacao!({ ...c.ctx, segredoWebhook: null }, query!("desafio_123", true))).toBeNull();
      });
    });

    describe.skipIf(!cap.consulta.porId)("consulta (só com consulta por id)", () => {
      it("para uma ligação encerrada, devolve um fim com a causa real", async () => {
        for (const causa of ["atendida", "nao_atendeu"] as const) {
          const l = await ligarEConduzir(c, { causa });
          const r = await c.provedor.consultar!(c.ctx, l.providerCallId);
          const fim = r.fatos.find((f) => f.tipo === "encerrada");
          expect(fim && fim.tipo === "encerrada" && fim.causa, `causa ${causa}`).toBe(causa);
        }
      });

      it("ligação que o provedor não conhece lança nao_encontrado", async () => {
        expect(await erroDe(() => c.provedor.consultar!(c.ctx, "pc_que_nao_existe"))).toBeInstanceOf(NaoEncontradoDeLigacao);
      });
    });

    describe("gravação", () => {
      it("chega por onde a matriz diz, o arquivo confere com o sha256 e o prazo é o declarado", async () => {
        expect(await conferirGravacao(c)).toEqual([]);
      });
    });

    describe("erros neutros", () => {
      it("cada resposta de erro cai num dos 8 erros neutros, com o código esperado", async () => {
        expect(await conferirErrosNeutros(c)).toEqual([]);
      });
    });

    describe("honestidade da matriz", () => {
      it("capacidade sim tem prova que passa, capacidade não faz a operação ser recusada", async () => {
        expect(await conferirHonestidadeDaMatriz(c)).toEqual([]);
      });
    });

    describe("sigilo", () => {
      it("nenhum segredo aparece em erro, resposta nem verificação de aviso", async () => {
        expect(await conferirSigilo(c)).toEqual([]);
      });
    });
  });
}
