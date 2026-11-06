import type { ChaveDeProvedorDeLigacao } from "../capacidades";
import { criarRegistroDeLigacao, flagDoProvedorDeLigacao, type ProvedorRegistradoDeLigacao, type RegistroDeProvedoresDeLigacao } from "../registro";
import { FakeProvedorDeLigacao } from "./fake-provedor";
import { PERFIS_DO_FAKE_DE_LIGACAO, capacidadesDoPerfilDeLigacao, descritorDoFakeDeLigacao, type PerfilDoFakeDeLigacao } from "./perfis";

/**
 * Quando o Fake de ligação entra no registro.
 *
 * - Com `NODE_ENV=test`: sempre.
 * - Em desenvolvimento (`NODE_ENV=development`): só com `LIGACAO_FAKE=on`.
 * - Em produção: NUNCA, mesmo com `LIGACAO_FAKE=on`. Sem `NODE_ENV` também não (fecha por padrão).
 *
 * O registro padrão do app (`registroPadraoDeLigacao`) não importa o Fake de propósito: o Fake fica fora do
 * barrel e fora do bundle de quem não pede. Quem monta o registro do app para desenvolvimento chama
 * `registrarFakeDeLigacao`, que faz a conferência de ambiente aqui dentro.
 *
 * `comprovado` do Fake é false. Só vira true em `NODE_ENV=test`, para o teste ponta a ponta provar o caminho
 * da ligação comprovada; fora do teste o pedido é ignorado, porque o Fake nunca prova nada de verdade.
 */

export type AmbienteDoProcessoDeLigacao = Readonly<Record<string, string | undefined>>;

export const CHAVES_DO_FAKE_DE_LIGACAO: Readonly<Record<PerfilDoFakeDeLigacao, ChaveDeProvedorDeLigacao>> = {
  so_no_fim: "fake_so_no_fim",
  ao_vivo: "fake_ao_vivo",
  sem_consulta: "fake_sem_consulta",
};

export function fakeDeLigacaoPermitido(env: AmbienteDoProcessoDeLigacao = process.env): boolean {
  if (env.NODE_ENV === "test") return true;
  return env.NODE_ENV === "development" && env.LIGACAO_FAKE === "on";
}

/**
 * A entrada de registro de um perfil. Sem `fake`, cada `fabrica()` cria um Fake novo; para o teste ponta a
 * ponta enxergar o estado do mesmo Fake, passe a instância (a chave dela precisa ser a do perfil).
 */
export function entradaDoFakeDeLigacao(perfil: PerfilDoFakeDeLigacao, opcoes: { comprovado?: boolean; fake?: FakeProvedorDeLigacao; env?: AmbienteDoProcessoDeLigacao } = {}): ProvedorRegistradoDeLigacao {
  const chave = CHAVES_DO_FAKE_DE_LIGACAO[perfil];
  const fakeDado = opcoes.fake;
  if (fakeDado && fakeDado.chave !== chave) throw new Error("O Fake passado não tem a chave do perfil.");
  const env = opcoes.env ?? process.env;
  return {
    chave,
    rotulo: `Provedor de teste (${perfil})`,
    capacidades: fakeDado?.capacidades ?? capacidadesDoPerfilDeLigacao(perfil),
    descritor: descritorDoFakeDeLigacao(perfil, chave, fakeDado?.capacidades),
    fabrica: () => fakeDado ?? new FakeProvedorDeLigacao({ perfil, chave }),
    comprovado: opcoes.comprovado === true && env.NODE_ENV === "test",
    flag: flagDoProvedorDeLigacao(chave),
  };
}

/**
 * Registra o Fake (os perfis pedidos, ou os três) SE o ambiente permite. Devolve as chaves registradas:
 * vazio quando o ambiente não permite (em produção, sempre).
 */
export function registrarFakeDeLigacao(
  registro: RegistroDeProvedoresDeLigacao,
  opcoes: { env?: AmbienteDoProcessoDeLigacao; perfis?: readonly PerfilDoFakeDeLigacao[]; comprovado?: boolean; fakes?: Partial<Record<PerfilDoFakeDeLigacao, FakeProvedorDeLigacao>> } = {},
): ChaveDeProvedorDeLigacao[] {
  const env = opcoes.env ?? process.env;
  if (!fakeDeLigacaoPermitido(env)) return [];
  const registradas: ChaveDeProvedorDeLigacao[] = [];
  for (const perfil of opcoes.perfis ?? PERFIS_DO_FAKE_DE_LIGACAO) {
    registro.registrar(entradaDoFakeDeLigacao(perfil, { comprovado: opcoes.comprovado, fake: opcoes.fakes?.[perfil], env }));
    registradas.push(CHAVES_DO_FAKE_DE_LIGACAO[perfil]);
  }
  return registradas;
}

/** Um registro novo só com o Fake (vazio quando o ambiente não permite). */
export function criarRegistroDeLigacaoComFake(opcoes: Parameters<typeof registrarFakeDeLigacao>[1] = {}): RegistroDeProvedoresDeLigacao {
  const registro = criarRegistroDeLigacao();
  registrarFakeDeLigacao(registro, opcoes);
  return registro;
}
