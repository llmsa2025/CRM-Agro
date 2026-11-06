import { compararNome } from "@crmagro/captation";
import { classificaCnae } from "../produtor/classify";
import { AGRO_TIPOS, type AgroTipo, type Evidencia, type LeituraDaFoto } from "./schema";

/**
 * Regras do verificador do agro. PURO: sem banco, sem rede, sem IA. Recebe o que o serviço juntou do contato e
 * devolve os tipos e as evidências de cada um.
 *
 * Como decide: cada evidência tem um PESO (2 forte, 1 fraco, 0 só informa) e uma FONTE (nome, empresa, sócio,
 * foto). Dentro de uma fonte vale a maior evidência; entre fontes elas se somam. Um tipo entra com 2 pontos:
 * um sinal forte sozinho, ou dois fracos de fontes diferentes. Assim "Armazém do Zé" (mercearia) não vira
 * armazém geral só pelo nome, mas vira com uma foto de silo ou com o CNAE 52.11.
 *
 * Pecuária vem da foto (gado) ou do nome ("pecuária", "gado"); transportadora, do nome ("transportadora",
 * "transportes") ou do CNAE de transporte rodoviário de carga da empresa vinculada.
 *
 * "produtor" é diferente dos outros: só entra quando o nome do contato bate com um sócio de uma empresa que
 * tem atividade rural (é o que confirma que a PESSOA é dona ou sócia, e não só conhecida da fazenda).
 */

export const AGRO_REGRA_VERSAO = "agro@2026-10-26";

export type EmpresaParaAgro = {
  nome: string;
  cnae: string | null;
  cnaesSecundarios: string[];
  /** Tipo de cada inscrição estadual (Sintegra), como "Produtor Rural". */
  iesTipos: (string | null | undefined)[];
  /** Nomes dos sócios (quadro societário da Receita). */
  socios: string[];
};

export type EntradaDaVerificacao = {
  /** Nome + sobrenome do cadastro. */
  nome: string;
  /** Nome do perfil no WhatsApp e o nome salvo na agenda do celular. */
  nomeWhatsapp: string | null;
  nomeAgenda: string | null;
  /** Campo "empresa" do cadastro do contato (texto livre). */
  empresaTexto: string | null;
  empresas: EmpresaParaAgro[];
  /** Leitura da foto do WhatsApp, quando já foi feita. */
  foto: LeituraDaFoto | null;
};

export type ResultadoDaVerificacao = { tipos: AgroTipo[]; evidencias: Evidencia[] };

const MAX_EVIDENCIAS = 40;
const PONTOS_PARA_ENTRAR = 2;

const semAcento = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Trecho curto para a evidência: o nome pode vir comprido (grupo, emoji, slogan). */
const curto = (t: string, max = 60) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

// ---------------------------------------------------------------------------
// Nome
// ---------------------------------------------------------------------------

type RegraDeNome = { tipo: AgroTipo; peso: 1 | 2; re: RegExp };

/**
 * Em texto sem acento e em minúsculas. A ordem importa: dentro do mesmo texto, a regra forte de um tipo vem
 * antes da fraca e a fraca é ignorada. "Armazém" sozinho é fraco de propósito (mercearia também se chama assim);
 * "armazém geral", silo e cerealista são fortes. "Algodão" sozinho também é fraco: serve a quem planta.
 */
const REGRAS_DE_NOME: RegraDeNome[] = [
  { tipo: "algodoeira", peso: 2, re: /\b(algodoeira|descarocadora|beneficiadora de algodao|usina de algodao)\b/ },
  { tipo: "algodoeira", peso: 1, re: /\balgodao\b/ },
  { tipo: "armazem", peso: 2, re: /\b(armaz(?:em|ens) gerais?|silos?|graneleiros?|cerealista)\b/ },
  { tipo: "armazem", peso: 1, re: /\barmaz(?:em|ens)\b/ },
  // "faz." só com o ponto (sem ele é o verbo "faz"); o \b depois do ponto nunca fecha, por isso fica fora do grupo.
  { tipo: "fazenda", peso: 2, re: /\b(?:fazendas?|sitio|chacara|estancia|granja|agropecuaria|agropastoril)\b|\bfaz\./ },
  { tipo: "fazenda", peso: 1, re: /\b(agricola|agro|rural|lavoura|graos)\b/ },
  // "agropecuaria" não casa aqui (sem fronteira de palavra antes de "pecuaria"): continua sendo fazenda.
  { tipo: "pecuaria", peso: 2, re: /\b(pecuaria|pecuarista|pecuaristas|gado|bovinos?|bovinocultura)\b/ },
  { tipo: "pecuaria", peso: 1, re: /\b(bois?|boiadeiros?|bezerros?|nelore|confinamento|leiteiros?|leiteiras?)\b/ },
  // "Transportes" no plural é nome de empresa de frete; "transporte" e "frete" sozinhos podem ser outra coisa.
  { tipo: "transportadora", peso: 2, re: /\b(transportadoras?|transportes)\b/ },
  { tipo: "transportadora", peso: 1, re: /\b(transporte|fretes?|logistica|cargas)\b/ },
];

/**
 * `deOutraEntidade`: o nome é da empresa vinculada (ou do campo "empresa"), não da própria pessoa. Aí "fazenda"
 * vale só como sinal fraco: quem é sócio de uma agropecuária é PRODUTOR (regra dos sócios), não a fazenda em si.
 * Armazém e algodoeira seguem inteiros, porque não existe um tipo "pessoa" para eles.
 */
function evidenciasDeNome(rotulo: string, valor: string | null | undefined, deOutraEntidade = false): Evidencia[] {
  const bruto = (valor ?? "").trim();
  if (!bruto) return [];
  const texto = semAcento(bruto);
  const jaTem = new Set<AgroTipo>();
  const out: Evidencia[] = [];
  for (const r of REGRAS_DE_NOME) {
    if (jaTem.has(r.tipo)) continue;
    const m = r.re.exec(texto);
    if (!m) continue;
    jaTem.add(r.tipo);
    const peso = deOutraEntidade && r.tipo === "fazenda" ? 1 : r.peso;
    out.push({
      tipo: r.tipo,
      fonte: "nome",
      peso,
      texto: `${rotulo} "${curto(bruto)}" tem "${m[0]}"${peso === 1 ? " (sinal fraco, precisa de outro)" : ""}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empresa (CNAE, inscrição estadual e sócios)
// ---------------------------------------------------------------------------

const PRODUCAO_DIRETA = new Set(["lavoura_temporaria", "lavoura_permanente", "pecuaria", "horticultura", "sementes_mudas", "florestal_pesca"]);

const ATIVIDADE_POR_CATEGORIA: Record<string, string> = {
  lavoura_temporaria: "lavoura",
  lavoura_permanente: "lavoura",
  pecuaria: "pecuária",
  horticultura: "horticultura",
  sementes_mudas: "sementes e mudas",
  florestal_pesca: "floresta ou pesca",
  apoio_agropecuario: "apoio agropecuário",
  pos_colheita: "pós-colheita (algodoeira)",
  armazem: "armazém geral",
  atacadista_agricola: "atacado agrícola",
  fiacao: "fiação",
};

/** CNAE 49.30-2: transporte rodoviário de carga (todas as subclasses). */
const ehTransporteDeCarga = (codigo: string) => codigo.replace(/\D/g, "").startsWith("4930");

/** A atividade do CNAE em palavras ("lavoura", "armazém geral"), ou null quando não é do agro. Vai junto do pedido de leitura da foto. */
export function atividadeDoCnae(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  if (ehTransporteDeCarga(codigo)) return "transporte de carga";
  return ATIVIDADE_POR_CATEGORIA[classificaCnae(codigo)] ?? null;
}

function temAtividadeRural(e: EmpresaParaAgro): { sim: boolean; motivo: string } {
  const codigos = [e.cnae, ...e.cnaesSecundarios].filter((c): c is string => Boolean(c));
  const achado = codigos.find((c) => PRODUCAO_DIRETA.has(classificaCnae(c)));
  if (achado) return { sim: true, motivo: `CNAE ${achado}` };
  if (e.iesTipos.some((t) => /produtor/i.test(t ?? ""))) return { sim: true, motivo: "inscrição estadual de produtor rural" };
  return { sim: false, motivo: "" };
}

function evidenciasDaEmpresa(e: EmpresaParaAgro, pessoa: { rotulo: string; valor: string }[]): Evidencia[] {
  const out: Evidencia[] = [];
  const nome = curto(e.nome, 50);

  if (e.cnae) {
    const cat = classificaCnae(e.cnae);
    if (cat === "armazem") {
      out.push({ tipo: "armazem", fonte: "empresa", peso: 2, texto: `${nome} tem armazém geral como atividade principal (CNAE ${e.cnae})` });
    } else if (cat === "pos_colheita") {
      out.push({ tipo: "algodoeira", fonte: "empresa", peso: 1, texto: `${nome} tem pós-colheita como atividade principal (CNAE ${e.cnae}), comum em algodoeira` });
    } else if (cat === "pecuaria") {
      out.push({ tipo: "pecuaria", fonte: "empresa", peso: 1, texto: `${nome} tem pecuária como atividade principal (CNAE ${e.cnae}), falta outro sinal (foto de gado ou o nome)` });
    } else if (ehTransporteDeCarga(e.cnae)) {
      out.push({ tipo: "transportadora", fonte: "empresa", peso: 2, texto: `${nome} tem transporte rodoviário de carga como atividade principal (CNAE ${e.cnae})` });
    }
  }
  if (e.cnaesSecundarios.some((c) => classificaCnae(c) === "armazem")) {
    out.push({ tipo: "armazem", fonte: "empresa", peso: 1, texto: `${nome} tem armazém geral entre as atividades secundárias` });
  }
  // Só vale como sinal fraco: o principal é a atividade que decide, e a empresa pode ter o transporte só de apoio.
  if (!(e.cnae && ehTransporteDeCarga(e.cnae)) && e.cnaesSecundarios.some(ehTransporteDeCarga)) {
    out.push({ tipo: "transportadora", fonte: "empresa", peso: 1, texto: `${nome} tem transporte rodoviário de carga entre as atividades secundárias` });
  }

  const rural = temAtividadeRural(e);
  // Só confere os sócios de quem produz: ser sócio de uma loja de roupas não faz ninguém produtor.
  const achados = e.socios
    .flatMap((socio) =>
      pessoa.map((p) => ({ socio, p, c: compararNome(p.valor, socio) })).filter((x): x is typeof x & { c: "exato" | "parcial" } => x.c !== null),
    )
    .sort((a, b) => (a.c === b.c ? 0 : a.c === "exato" ? -1 : 1));
  const melhor = achados[0];

  if (rural.sim) {
    if (melhor) {
      out.push({
        tipo: "produtor",
        fonte: "socio",
        peso: 2,
        texto:
          melhor.c === "exato"
            ? `${melhor.p.rotulo} "${curto(melhor.p.valor)}" é o sócio ${curto(melhor.socio)} de ${nome}, que tem atividade rural (${rural.motivo})`
            : `${melhor.p.rotulo} "${curto(melhor.p.valor)}" bate com parte do nome do sócio ${curto(melhor.socio)} de ${nome}, que tem atividade rural (${rural.motivo}). Confira`,
      });
    } else if (e.socios.length === 0) {
      out.push({ tipo: null, fonte: "socio", peso: 0, texto: `${nome} tem atividade rural (${rural.motivo}), mas o CRM Agro não tem a lista de sócios para conferir. Enriqueça a empresa` });
    } else {
      out.push({ tipo: null, fonte: "socio", peso: 0, texto: `Nenhum dos ${e.socios.length} sócio(s) de ${nome} bate com o nome do contato` });
    }
  } else if (melhor) {
    out.push({ tipo: null, fonte: "socio", peso: 0, texto: `${melhor.p.rotulo} "${curto(melhor.p.valor)}" bate com o sócio ${curto(melhor.socio)} de ${nome}, mas a empresa não tem atividade rural` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Foto
// ---------------------------------------------------------------------------

function evidenciaDaFoto(f: LeituraDaFoto): Evidencia {
  const tipo: AgroTipo | null =
    f.categoria === "fazenda" || f.categoria === "lavoura"
      ? "fazenda"
      : f.categoria === "armazem"
        ? "armazem"
        : f.categoria === "algodoeira"
          ? "algodoeira"
          : f.categoria === "pecuaria"
            ? "pecuaria"
            : null;
  const peso = tipo ? (f.confianca === "alta" ? 2 : f.confianca === "media" ? 1 : 0) : 0;
  const rotulo = f.categoria === "outra" ? "não mostra o agro" : f.categoria === "lavoura" ? "lavoura" : f.categoria === "pecuaria" ? "gado" : f.categoria;
  return { tipo, fonte: "foto", peso, texto: `Foto do WhatsApp (${rotulo}, confiança ${f.confianca}): ${curto(f.motivo, 200)}` };
}

// ---------------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------------

export function verificarAgro(entrada: EntradaDaVerificacao): ResultadoDaVerificacao {
  const pessoa: { rotulo: string; valor: string }[] = [
    { rotulo: "O nome do cadastro", valor: entrada.nome },
    ...(entrada.nomeWhatsapp ? [{ rotulo: "O nome no WhatsApp", valor: entrada.nomeWhatsapp }] : []),
    ...(entrada.nomeAgenda ? [{ rotulo: "O nome na agenda do celular", valor: entrada.nomeAgenda }] : []),
  ];

  const evidencias: Evidencia[] = [
    ...evidenciasDeNome("O nome do cadastro", entrada.nome),
    ...evidenciasDeNome("O nome no WhatsApp", entrada.nomeWhatsapp),
    ...evidenciasDeNome("O nome na agenda do celular", entrada.nomeAgenda),
    ...evidenciasDeNome("O campo empresa", entrada.empresaTexto, true),
    ...entrada.empresas.flatMap((e) => [...evidenciasDeNome("O nome da empresa", e.nome, true), ...evidenciasDaEmpresa(e, pessoa)]),
    ...(entrada.foto ? [evidenciaDaFoto(entrada.foto)] : []),
  ];

  // Dentro de uma fonte vale a maior evidência; entre fontes elas se somam.
  const maior = new Map<string, number>();
  for (const ev of evidencias) {
    if (!ev.tipo || ev.peso === 0) continue;
    const k = `${ev.tipo}|${ev.fonte}`;
    maior.set(k, Math.max(maior.get(k) ?? 0, ev.peso));
  }
  const pontos = (tipo: AgroTipo) => [...maior].filter(([k]) => k.startsWith(`${tipo}|`)).reduce((s, [, p]) => s + p, 0);
  const tipos = AGRO_TIPOS.filter((t) => pontos(t) >= PONTOS_PARA_ENTRAR);

  // Quem decidiu vem primeiro; o resto (só informa) depois. O corte protege o Json de um cadastro com muitas empresas.
  const ordenadas = [...evidencias].sort((a, b) => b.peso - a.peso);
  return { tipos, evidencias: ordenadas.slice(0, MAX_EVIDENCIAS) };
}
