import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { safeEnrollByTrigger } from "../flows/triggers";
import { logger } from "../logger/index";
import { assertOwned, assertOwnedMany } from "../tenancy/assert-owned";
import { TagNotFound } from "./errors";
import { chaveDaTag, nomeDaTag } from "./por-nome";

/**
 * Tags do contato digitadas no campo "Tags" (cadastro, edição e planilha importada).
 *
 * O campo grava texto em `Contact.tags` (legado), mas a barra de filtro da tela de Contatos, o autocomplete e a
 * tag da linha leem o catálogo (`Tag` + `ContactTag`). Sem uma ponte, a tag digitada nunca aparecia no filtro (a
 * mesma raiz do incidente de 02/10/2026, a documentação interna, que o passo "Adicionar
 * tag" já corrigiu em `por-nome.ts`). Aqui o texto vira tag do time (criada se não existir, sem duplicar por
 * caixa nem por acento) e fica vinculado ao contato. O campo legado continua gravado como antes: quem ainda lê
 * dele (exportação, Ligações, variáveis de campanha) não muda.
 *
 * Na EDIÇÃO só vale a DIFERENÇA entre o que a pessoa via ao abrir o campo e o que ela deixou (`diferencaDeTags`),
 * nunca a lista inteira. Assim, salvar sem mexer nas tags não toca em nada, tag que entrou por outro caminho
 * enquanto a ficha estava aberta não é apagada, e tag que só existia no campo antigo não é religada nem dispara
 * fluxo por engano. Diferente da atribuição manual da linha (uma tag só, `setContactTag`), o campo aceita várias
 * tags por contato, como sempre aceitou.
 */

/** Tag do catálogo, no formato que a tela usa. */
export type TagDoContato = { id: string; nome: string; cor: string | null };

type Cliente = ReturnType<typeof db>;

/** Tags lidas do catálogo para comparar nomes sem caixa e sem acento (o mesmo teto de `garantirTagPorNome`). */
const CATALOGO_MAX = 5000;
/** Contatos por consulta e vínculos por gravação nos caminhos em lote. */
const LOTE = 1000;
/** Tags por contato que entram no catálogo de uma vez; o excedente de uma lista absurda é descartado. */
export const MAX_TAGS_POR_CONTATO = 50;

/**
 * Marcas que o motor, a IA e a ligação gravam SÓ em `Contact.tags` (campo legado). Não são rótulos que a equipe
 * escolheu: servem de bandeira para condição de fluxo ("Tem Histórico", "Sem Canal"), registro de opt-out e pedido
 * da IA. Por isso NÃO entram no catálogo: a barra de filtro ficaria cheia de marcas internas e sempre defasada
 * (quem as grava não passa pelo catálogo, e "Número errado" ainda é tirada de lá quando o número é corrigido).
 * Continuam visíveis na ficha e no campo "Tags". Os testes conferem esta lista contra as constantes de
 * `calls/resultado.ts` e `conversations/opt-out.ts` e contra cada `pushTagOnce(...)` do executor de fluxos.
 */
export const MARCAS_DO_SISTEMA: readonly string[] = [
  "Número errado",
  "Pediu para sair",
  "Sem Canal",
  "Tem Histórico",
  "IA: precisa de uma pessoa",
];
const CHAVES_DAS_MARCAS = new Set(MARCAS_DO_SISTEMA.map(chaveDaTag));
/** Toda tag que a ferramenta de IA aplica começa com "IA:" (`ai/tools.ts`). */
const PREFIXO_DAS_TAGS_DA_IA = "ia:";

/** É uma marca interna que fica só no campo legado (não vira tag do catálogo)? */
export function ehMarcaDoSistema(nome: string): boolean {
  const chave = chaveDaTag(nome);
  return CHAVES_DAS_MARCAS.has(chave) || chave.startsWith(PREFIXO_DAS_TAGS_DA_IA);
}

/**
 * Nomes que vão para o catálogo a partir do que foi digitado: sem vazio, sem repetição (sem caixa e sem acento;
 * vale a primeira grafia), no tamanho do cadastro de tag, sem as marcas internas do sistema (`MARCAS_DO_SISTEMA`) e
 * no máximo `MAX_TAGS_POR_CONTATO`.
 */
export function nomesParaOCatalogo(brutos: readonly string[]): string[] {
  const vistos = new Set<string>();
  const nomes: string[] = [];
  for (const bruto of brutos) {
    if (nomes.length >= MAX_TAGS_POR_CONTATO) break;
    const nome = nomeDaTag(bruto);
    const chave = chaveDaTag(nome);
    if (!chave || vistos.has(chave) || ehMarcaDoSistema(nome)) continue;
    vistos.add(chave);
    nomes.push(nome);
  }
  return nomes;
}

/**
 * Junta listas de nomes sem repetir (sem caixa e sem acento). A primeira grafia que aparece fica, então a lista
 * do catálogo vai antes da do campo legado. Não corta o tamanho: é para mostrar, não para gravar.
 */
export function unirNomesDeTag(...listas: readonly (readonly string[])[]): string[] {
  const vistos = new Set<string>();
  const nomes: string[] = [];
  for (const lista of listas) {
    for (const bruto of lista) {
      const nome = bruto.replace(/\s+/g, " ").trim();
      const chave = chaveDaTag(nome);
      if (!chave || vistos.has(chave)) continue;
      vistos.add(chave);
      nomes.push(nome);
    }
  }
  return nomes;
}

/** O que a pessoa fez no campo: tags postas e tags tiradas (por nome, na grafia em que foram vistas). */
export type MudancaDeTags = { adicionadas: string[]; removidas: string[] };

export const temMudanca = (m: MudancaDeTags): boolean => m.adicionadas.length > 0 || m.removidas.length > 0;

/**
 * A diferença entre o que a pessoa via (`antes`) e o que deixou (`depois`), por nome sem caixa e sem acento.
 * `adicionadas` na grafia de `depois`; `removidas` na de `antes`. Listas iguais não têm diferença.
 */
export function diferencaDeTags(antes: readonly string[], depois: readonly string[]): MudancaDeTags {
  const chavesAntes = new Set(antes.map(chaveDaTag));
  const chavesDepois = new Set(depois.map(chaveDaTag));
  return {
    adicionadas: unirNomesDeTag(depois).filter((n) => !chavesAntes.has(chaveDaTag(n))),
    removidas: unirNomesDeTag(antes).filter((n) => !chavesDepois.has(chaveDaTag(n))),
  };
}

/**
 * `Contact.tags` depois da mudança: o que o contato tem AGORA no campo, sem as tiradas, mais as postas. Não mexe
 * no resto (marca que o motor pôs enquanto a ficha estava aberta fica), nem na grafia do que já estava.
 */
export function legadoComMudanca(legadoAtual: readonly string[], mudanca: MudancaDeTags): string[] {
  const tirar = new Set(mudanca.removidas.map(chaveDaTag));
  const manter = legadoAtual.filter((n) => !tirar.has(chaveDaTag(n)));
  const ja = new Set(manter.map(chaveDaTag));
  return [...manter, ...mudanca.adicionadas.filter((n) => !ja.has(chaveDaTag(n)))];
}

/** O catálogo do time por chave de comparação (a tag mais antiga de cada nome vence). */
async function catalogoPorChave(prisma: Cliente): Promise<Map<string, TagDoContato>> {
  const todas = await prisma.tag.findMany({
    select: { id: true, nome: true, cor: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CATALOGO_MAX,
  });
  const porChave = new Map<string, TagDoContato>();
  for (const t of todas) {
    const chave = chaveDaTag(t.nome);
    if (!porChave.has(chave)) porChave.set(chave, t);
  }
  return porChave;
}

/**
 * Acha no catálogo (ou cria) as tags dos nomes, todas de uma vez. `faltavam` são os nomes que não estavam lá.
 * Com `INSERT ... ON CONFLICT DO NOTHING`, um cadastro simultâneo do mesmo nome não dá erro e a tag que ganhou é a
 * usada. Com `criar: false` só olha (simulação): quem pedir um nome que faltava não o encontra em `porChave`.
 */
async function garantirTags(
  prisma: Cliente,
  nomes: readonly string[],
  criar = true,
): Promise<{ porChave: Map<string, TagDoContato>; faltavam: string[] }> {
  const porChave = await catalogoPorChave(prisma);
  const faltavam = nomes.filter((n) => !porChave.has(chaveDaTag(n)));
  if (faltavam.length === 0 || !criar) return { porChave, faltavam };
  await prisma.tag.createMany({
    data: faltavam.map((nome) => tenantData<Prisma.TagCreateManyInput>({ nome })),
    skipDuplicates: true,
  });
  // Relê só as que faltavam, pelo nome exato (vale também quando o catálogo passa do teto lido acima).
  const novas = await prisma.tag.findMany({
    where: { nome: { in: faltavam } },
    select: { id: true, nome: true, cor: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const t of novas) {
    const chave = chaveDaTag(t.nome);
    if (!porChave.has(chave)) porChave.set(chave, t);
  }
  return { porChave, faltavam };
}

/**
 * As tags do contato como a ficha e o formulário mostram: as do catálogo (na ordem em que foram postas) e, depois,
 * as que só existem no campo legado (`legado`), sem repetir. Leitura: o chamador já confirmou que vê o contato.
 */
export async function tagsDoContato(contactId: string, legado: readonly string[] = []): Promise<string[]> {
  const prisma = db();
  const vinculos = await prisma.contactTag.findMany({
    where: { contactId },
    orderBy: [{ createdAt: "asc" }, { tag: { nome: "asc" } }],
    select: { tag: { select: { nome: true } } },
  });
  return unirNomesDeTag(
    vinculos.map((v) => v.tag.nome),
    legado,
  );
}

type OpcoesDaMudanca = {
  /** Dispara os fluxos de gatilho "tag adicionada" para cada vínculo que ESTA chamada criou (como a atribuição manual). */
  gatilho?: boolean;
  /** Cascata do motor (passo de fluxo que adiciona tag); 0 para ação de pessoa. */
  profundidade?: number;
};

export type ResultadoDaMudanca = {
  /** Tags cujo vínculo esta chamada criou (quem já tinha a tag, ou ganhou de outra gravação, não conta). */
  adicionadas: TagDoContato[];
  /** Quantos vínculos esta chamada desfez. */
  removidas: number;
};

/**
 * Aplica no catálogo a mudança que a pessoa fez no campo "Tags": cria as tags que faltam, vincula as postas e
 * desfaz o vínculo das tiradas (por nome, sem caixa e sem acento). SÓ a diferença: o que não está na `mudanca` não
 * é tocado. As marcas internas do sistema (`MARCAS_DO_SISTEMA`) são ignoradas aqui: ficam só no campo legado.
 * Com `gatilho`, os fluxos "tag adicionada" disparam só para vínculo que esta chamada de fato criou.
 */
export async function aplicarMudancaDeTags(
  contactId: string,
  mudanca: MudancaDeTags,
  opts: OpcoesDaMudanca = {},
): Promise<ResultadoDaMudanca> {
  requireCan("tags.write");
  const prisma = db();
  // S1: sem isto, um ContactTag do meu time apontava para contato de outro time.
  await assertOwned("contact", contactId);

  const paraAdicionar = nomesParaOCatalogo(mudanca.adicionadas);
  const chavesATirar = new Set(mudanca.removidas.map(chaveDaTag));
  if (paraAdicionar.length === 0 && chavesATirar.size === 0) return { adicionadas: [], removidas: 0 };

  const { porChave } = paraAdicionar.length ? await garantirTags(prisma, paraAdicionar) : { porChave: new Map<string, TagDoContato>() };
  const alvo: TagDoContato[] = [];
  for (const nome of paraAdicionar) {
    const tag = porChave.get(chaveDaTag(nome));
    if (!tag) throw new TagNotFound(nome); // só se apagarem a tag nesse instante
    if (!alvo.some((t) => t.id === tag.id)) alvo.push(tag);
  }

  const vinculos = await prisma.contactTag.findMany({
    where: { contactId },
    select: { id: true, tagId: true, tag: { select: { nome: true } } },
  });
  const tirar = vinculos.filter((v) => chavesATirar.has(chaveDaTag(v.tag.nome))).map((v) => v.id);
  const jaTem = new Set(vinculos.map((v) => v.tagId));
  const novas = alvo.filter((t) => !jaTem.has(t.id));

  const criadas: TagDoContato[] = [];
  if (tirar.length > 0 || novas.length > 0) {
    // `createdAt` cresce 1 ms por tag, na ordem digitada: um INSERT só dá a mesma hora a todas e a ficha as
    // mostraria em ordem qualquer.
    const inicio = Date.now();
    await prisma.$transaction(async (tx) => {
      if (tirar.length > 0) await tx.contactTag.deleteMany({ where: { id: { in: tirar } } });
      // Uma de cada vez: o `count` do `INSERT ... ON CONFLICT DO NOTHING` diz se ESTA chamada criou o vínculo.
      // Duas gravações simultâneas da mesma tag (o formulário e o passo de fluxo, por exemplo) disparam o fluxo uma vez.
      for (const [i, tag] of novas.entries()) {
        const { count } = await tx.contactTag.createMany({
          data: [tenantData<Prisma.ContactTagCreateManyInput>({ contactId, tagId: tag.id, createdAt: new Date(inicio + i) })],
          skipDuplicates: true,
        });
        if (count === 1) criadas.push(tag);
      }
    });
  }
  if (opts.gatilho) {
    for (const tag of criadas) {
      await safeEnrollByTrigger("tag_added", { contactId, tagId: tag.id, profundidade: opts.profundidade ?? 0 });
    }
  }
  return { adicionadas: criadas, removidas: tirar.length };
}

/**
 * Cadastro novo: vincula ao contato recém-criado as tags digitadas. Só SOMA e nunca derruba o cadastro: o campo
 * legado já guarda as tags, então se o catálogo falhar o contato continua certo (a tag some só da barra de filtro,
 * e a ficha ainda a mostra) e o erro vai para o log. Dispara o gatilho "tag adicionada", como a atribuição manual.
 */
export async function vincularTagsDoCadastro(contactId: string, brutos: readonly string[]): Promise<void> {
  if (nomesParaOCatalogo(brutos).length === 0) return;
  try {
    await aplicarMudancaDeTags(contactId, { adicionadas: [...brutos], removidas: [] }, { gatilho: true });
  } catch (err) {
    logger.error(
      { contactId, err: err instanceof Error ? err.message : String(err) },
      "[tags] falha ao levar as tags do cadastro para o catálogo (o campo legado guarda o texto)",
    );
  }
}

export type ResumoDoLote = {
  /** Contatos que têm ao menos uma tag para o catálogo. */
  contatos: number;
  /** Nomes que não estavam no catálogo (criados, ou a criar na simulação), na primeira grafia vista. */
  tagsNovas: string[];
  /** Vínculos contato-tag que ainda não existiam. */
  vinculosNovos: number;
};

/**
 * Leva para o catálogo as tags de VÁRIOS contatos de uma vez (importação de planilha e migração dos dados
 * antigos). Só soma: nunca tira tag de ninguém, e NÃO dispara o gatilho "tag adicionada" (importar planilha não é
 * aplicar tag à mão, e o disparo em massa é decisão de quem aplica). Idempotente. Com `simular`, não grava nada:
 * só diz o que seria criado.
 */
export async function somarTagsEmLote(
  pares: readonly { contactId: string; nomes: readonly string[] }[],
  opts: { simular?: boolean } = {},
): Promise<ResumoDoLote> {
  requireCan("tags.write");
  const prisma = db();
  const comTags = pares
    .map((p) => ({ contactId: p.contactId, nomes: nomesParaOCatalogo(p.nomes) }))
    .filter((p) => p.nomes.length > 0);
  if (comTags.length === 0) return { contatos: 0, tagsNovas: [], vinculosNovos: 0 };
  await assertOwnedMany("contact", comTags.map((p) => p.contactId));

  // Uma grafia por nome (a primeira vista), para cada tag ser criada uma vez só.
  const grafia = new Map<string, string>();
  for (const p of comTags) for (const n of p.nomes) if (!grafia.has(chaveDaTag(n))) grafia.set(chaveDaTag(n), n);
  const { porChave, faltavam } = await garantirTags(prisma, [...grafia.values()], !opts.simular);

  // Os vínculos que o contato já tem, para contar (e gravar) só os novos.
  const ids = comTags.map((p) => p.contactId);
  const jaTem = new Set<string>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const achados = await prisma.contactTag.findMany({
      where: { contactId: { in: ids.slice(i, i + LOTE) } },
      select: { contactId: true, tagId: true },
    });
    for (const a of achados) jaTem.add(`${a.contactId}:${a.tagId}`);
  }
  const novos: { contactId: string; tagId: string; createdAt: Date }[] = [];
  let vinculosNovos = 0;
  const inicio = Date.now();
  for (const p of comTags) {
    const doContato = new Set<string>();
    for (const [posicao, nome] of p.nomes.entries()) {
      const tag = porChave.get(chaveDaTag(nome));
      if (!tag) {
        // Só na simulação a tag ainda não existe: o vínculo também seria novo.
        if (!opts.simular) throw new TagNotFound(nome);
        vinculosNovos++;
        continue;
      }
      if (doContato.has(tag.id) || jaTem.has(`${p.contactId}:${tag.id}`)) continue;
      doContato.add(tag.id);
      // Mesma ordem do texto (1 ms por posição), para a ficha mostrar as tags como foram digitadas.
      novos.push({ contactId: p.contactId, tagId: tag.id, createdAt: new Date(inicio + posicao) });
    }
  }
  vinculosNovos += novos.length;

  if (!opts.simular) {
    for (let i = 0; i < novos.length; i += LOTE) {
      await prisma.contactTag.createMany({
        data: novos.slice(i, i + LOTE).map((v) => tenantData<Prisma.ContactTagCreateManyInput>(v)),
        skipDuplicates: true,
      });
    }
  }
  return { contatos: comTags.length, tagsNovas: faltavam, vinculosNovos };
}

export type ResumoDaCatalogacao = ResumoDoLote & {
  /** Contatos do time que têm algo no campo legado `Contact.tags`. */
  lidos: number;
  /** Cada tag diferente do campo legado (fora as marcas do sistema) e quantos contatos a usam, as mais usadas primeiro. */
  todas: { nome: string; contatos: number }[];
  /** Quantas tags ficaram de fora por serem usadas por menos contatos que o `minimo`. */
  deForaPeloMinimo: number;
};

/**
 * Leva para o catálogo as tags que só existem no campo legado, de TODOS os contatos do time atual (migração
 * única dos dados antigos: tudo que foi digitado no campo "Tags" ou importado antes da ponte existir). Mesmas
 * regras de `somarTagsEmLote`: só soma, sem gatilho, idempotente, `simular` não grava. Anda por contato em
 * páginas, então pode ser interrompida e rodada de novo.
 *
 * O campo legado é texto livre, então a lista pode ter lixo. A primeira passada só conta (`todas`); a segunda
 * grava. Com `minimo` N, só entram as tags usadas por N contatos ou mais.
 */
export async function catalogarTagsLegadas(
  opts: { simular?: boolean; lote?: number; minimo?: number } = {},
): Promise<ResumoDaCatalogacao> {
  requireCan("tags.write");
  const prisma = db();
  const tamanho = opts.lote ?? LOTE;
  const minimo = Math.max(1, opts.minimo ?? 1);

  // Do mais antigo para o mais novo: quando o mesmo nome aparece com grafias diferentes ("soja", "Soja"), vale a
  // que a equipe usou primeiro. O `id` desempata para a página ser estável.
  const lerPagina = (depoisDe: string | undefined) =>
    prisma.contact.findMany({
      where: { tags: { isEmpty: false } },
      select: { id: true, tags: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: tamanho,
      ...(depoisDe ? { cursor: { id: depoisDe }, skip: 1 } : {}),
    });

  // 1ª passada: só conta quantos contatos usam cada tag.
  const uso = new Map<string, { nome: string; contatos: number }>();
  let lidos = 0;
  for (let cursor: string | undefined; ; ) {
    const pagina = await lerPagina(cursor);
    if (pagina.length === 0) break;
    cursor = pagina[pagina.length - 1]!.id;
    lidos += pagina.length;
    for (const c of pagina) {
      for (const nome of nomesParaOCatalogo(c.tags)) {
        const chave = chaveDaTag(nome);
        const u = uso.get(chave);
        if (u) u.contatos++;
        else uso.set(chave, { nome, contatos: 1 });
      }
    }
  }
  const todas = [...uso.values()].sort((a, b) => b.contatos - a.contatos || a.nome.localeCompare(b.nome, "pt-BR"));
  const permitidas = new Set(todas.filter((t) => t.contatos >= minimo).map((t) => chaveDaTag(t.nome)));
  const deForaPeloMinimo = todas.length - permitidas.size;

  // 2ª passada: grava (ou simula) só o que passou do mínimo.
  let contatos = 0;
  let vinculosNovos = 0;
  const novas = new Map<string, string>();
  for (let cursor: string | undefined; permitidas.size > 0; ) {
    const pagina = await lerPagina(cursor);
    if (pagina.length === 0) break;
    cursor = pagina[pagina.length - 1]!.id;
    const r = await somarTagsEmLote(
      pagina.map((c) => ({ contactId: c.id, nomes: c.tags.filter((n) => permitidas.has(chaveDaTag(n))) })),
      { simular: opts.simular },
    );
    contatos += r.contatos;
    vinculosNovos += r.vinculosNovos;
    // Na simulação o mesmo nome falta em todas as páginas: conta uma vez só.
    for (const nome of r.tagsNovas) if (!novas.has(chaveDaTag(nome))) novas.set(chaveDaTag(nome), nome);
  }
  return { lidos, contatos, tagsNovas: [...novas.values()], vinculosNovos, todas, deForaPeloMinimo };
}
