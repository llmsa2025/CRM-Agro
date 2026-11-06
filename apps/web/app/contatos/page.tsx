import { runAsUser, currentUser } from "@/lib/tenant";
import { temTela } from "@/lib/telas";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  listarContatosDaTela,
  BuscaMuitoLenta,
  BuscaFalhou,
  BUSCA_TETO,
  BUSCA_MIN_CARACTERES,
  listOrigens,
  listTags,
  tagFilterSummary,
  primaryEmail,
  primaryTelefone,
  TAG_NONE,
  can,
  listarPessoasDoTime,
  buscaExataDeContatos,
  agroTiposValidos,
  agroFiltroValido,
  andamentoDaVerificacaoAgro,
  lerAgroDetalhe,
  listarFluxosParaContatosSelecionados,
  AGRO_TIPOS,
  AGRO_ROTULO,
  AGRO_SEM_TIPO,
} from "@crmagro/core";
import type { RelacionamentoStatus, Interesse } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ContactsToolbar } from "./contacts-toolbar";
import { ContactsTable, type ContactRow } from "./ContactsTable";
import { PageSizeSelect } from "./PageSizeSelect";
import { ImportContactsMenu } from "./ImportContactsMenu";
import { ExportContactsMenu } from "./ExportContactsMenu";
import { AgroAndamento } from "./agro-andamento";
import { cn } from "@/lib/utils";
import { mensagemParaTela } from "@/lib/erros";

export const dynamic = "force-dynamic";

const PAGE_SIZES = [20, 50, 100, 250];
const DEFAULT_PAGE_SIZE = 50;

type SearchParams = Promise<{
  search?: string;
  status?: string;
  interesse?: string;
  origem?: string;
  tag?: string;
  produtor?: string;
  agro?: string;
  dono?: string;
  page?: string;
  pageSize?: string;
}>;

export default async function ContatosPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const search = sp.search;
  const status = (sp.status as RelacionamentoStatus | undefined) ?? undefined;
  const interesse = (sp.interesse as Interesse | undefined) ?? undefined;
  const origem = sp.origem;
  const tag = sp.tag;
  const produtor = sp.produtor;
  const agro = agroFiltroValido(sp.agro);
  const dono = sp.dono || undefined;
  const pageSize = PAGE_SIZES.includes(Number(sp.pageSize)) ? Number(sp.pageSize) : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const offset = (page - 1) * pageSize;

  // F3d: `dono` = "por vendedor" (o core só aplica para quem vê o time todo).
  const filter = { search, status, interesse, origem, tag, produtor, agro, dono };

  // "Rodar fluxo" só para quem tem a tela Fluxos e pode alterar (F2b): a action também confere.
  const usuario = await currentUser();
  const podeRodarFluxo = usuario?.role !== "viewer" && temTela(usuario?.role, usuario?.modulos, "fluxos");

  const [resultado, origens, tagSummary, tags, pessoas, podeTransferir, andamentoAgro, fluxosParaRodar] = await runAsUser(async () =>
    Promise.all([
      // A busca passou do tempo ou falhou: a tela mostra o motivo em texto simples, em vez de quebrar.
      listarContatosDaTela({ ...filter, historico: true }, { limit: pageSize, offset }).catch((e: unknown) =>
        e instanceof BuscaMuitoLenta || e instanceof BuscaFalhou ? { erro: mensagemParaTela(e, { semPrefixo: true }) } : Promise.reject(e),
      ),
      listOrigens(),
      tagFilterSummary(),
      listTags(),
      listarPessoasDoTime("contatos"),
      Promise.resolve(can("records.transfer")),
      andamentoDaVerificacaoAgro(),
      podeRodarFluxo && can("flows.write") ? listarFluxosParaContatosSelecionados() : Promise.resolve([]),
    ]),
  );
  const pessoasLite = pessoas.map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }));

  const erroDaBusca = "erro" in resultado ? resultado.erro : null;
  const lista = "erro" in resultado ? { items: [], total: 0, truncada: false, buscaAtiva: false, achados: {}, semHistorico: false } : resultado;
  const { total, truncada } = lista;

  const rows: ContactRow[] = lista.items.map((c) => {
    return {
      id: c.id,
      nome: c.nome,
      sobrenome: c.sobrenome,
      telefone: primaryTelefone(c.identifiers),
      email: primaryEmail(c.identifiers),
      empresa: c.empresa,
      status: c.relacionamentoStatus,
      interesse: c.interesse,
      origem: c.origem,
      createdAt: c.createdAt.toISOString(),
      // `contactTags` vem da mais nova para a mais antiga; a linha mostra todas, na ordem em que foram postas.
      tags: [...c.contactTags].reverse().map((ct) => ({ id: ct.tag.id, nome: ct.tag.nome, cor: ct.tag.cor })),
      whatsapp: primaryTelefone(c.identifiers),
      instagram: c.identifiers.find((i) => i.canal === "instagram")?.valor ?? null,
      linkedin: c.identifiers.find((i) => i.canal === "linkedin")?.valor ?? null,
      cidade: c.cidade,
      estado: c.estado,
      cargo: c.cargo,
      responsavel: c.owner?.name ?? null,
      agroTipos: agroTiposValidos(c.agroTipos),
      agroFoto: lerAgroDetalhe(c.agroDetalhe)?.foto?.estado ?? null,
      achados: lista.achados[c.id],
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + pageSize, total);
  // Busca com mais resultados do que o teto: o aviso fica logo acima da lista.
  const avisoTeto = truncada ? `A busca achou mais de ${BUSCA_TETO.toLocaleString("pt-BR")} contatos. Mostrei os ${BUSCA_TETO.toLocaleString("pt-BR")} mais novos. Refine a busca para ver o resto.` : null;
  const hasFilters = Boolean(search || status || interesse || origem || tag || produtor || agro || dono);
  const exportQuery = buildQuery({ search, status, interesse, origem, tag, produtor, agro, dono });
  // Busca que passou do teto: o total é "mais de N" (a lista e as ações em massa valem só até o teto).
  const totalTexto = truncada ? `mais de ${BUSCA_TETO.toLocaleString("pt-BR")}` : String(total);
  const subtitulo = hasFilters
    ? `${totalTexto} ${total === 1 && !truncada ? "contato" : "contatos"} no filtro · ${tagSummary.total} na base`
    : `${tagSummary.total} ${tagSummary.total === 1 ? "contato" : "contatos"}`;
  const buscou = Boolean(search && search.trim().length >= BUSCA_MIN_CARACTERES);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contatos"
        subtitle={subtitulo}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href="/contatos/duplicados">Duplicados</Link>
            </Button>
            <ExportContactsMenu csvHref={`/api/contatos/export?format=csv&${exportQuery}`} xlsxHref={`/api/contatos/export?format=xlsx&${exportQuery}`} />
            <ImportContactsMenu />
            <Button asChild>
              <Link href="/contatos/novo">Novo contato</Link>
            </Button>
          </>
        }
      />

      {/* Filtros: busca + relacionamento + interesse + origem; tags e agro como chips. */}
      <div className="flex flex-col gap-3">
        <ContactsToolbar origens={origens} pessoas={pessoasLite} buscaExata={buscaExataDeContatos()} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <TagChips summary={tagSummary} activeTag={tag} baseQuery={{ search, status, interesse, origem, produtor, agro, dono, pageSize }} />
          <span className="hidden h-4 w-px bg-line sm:block" aria-hidden />
          <AgroChips activeAgro={agro} activeProdutor={produtor} baseQuery={{ search, status, interesse, origem, tag, dono, pageSize }} />
        </div>
      </div>

      <AgroAndamento inicial={andamentoAgro} />

      {avisoTeto && rows.length > 0 && <p className="text-small text-ink-2">{avisoTeto}</p>}
      {lista.semHistorico && (
        <p className="text-small text-ink-2">Não deu para procurar no histórico agora, a busca demorou demais. Mostrei só os dados do contato e da empresa.</p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={erroDaBusca ? "Não consegui buscar" : buscou ? "Nenhum contato achado" : hasFilters ? "Nenhum contato com esse filtro" : "Você ainda não tem contatos"}
          description={
            erroDaBusca
              ? erroDaBusca
              : buscou
                ? "Não achei nada com esse texto nos dados do contato, da empresa nem no histórico. Confira a grafia ou limpe os filtros."
                : hasFilters
                  ? "Confira a grafia ou limpe os filtros para ver toda a base."
                  : "Importe uma planilha do seu CRM anterior ou cadastre o primeiro contato."
          }
          action={
            hasFilters ? (
              <Button asChild variant="outline">
                <Link href="/contatos">Limpar filtros</Link>
              </Button>
            ) : (
              <Button asChild>
                <Link href="/contatos/novo">Novo contato</Link>
              </Button>
            )
          }
          secondaryAction={
            !hasFilters ? (
              <Button asChild variant="outline">
                <Link href="/contatos/importar">Importar planilha</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <ContactsTable
          rows={rows}
          total={total}
          totalTruncado={truncada}
          filter={filter}
          tags={tags}
          exportQuery={exportQuery}
          // Transferir dono (F3d): só o administrador; destino = pessoas ativas.
          transferirPara={podeTransferir ? pessoasLite.filter((p) => p.ativo) : []}
          mostrarResponsavel={pessoasLite.length > 1}
          fluxosParaRodar={fluxosParaRodar}
          podeRodarFluxo={podeRodarFluxo}
        />
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-small text-ink-2">
          <div className="flex items-center gap-3">
            <span className="num">
              {rangeStart} a {rangeEnd} de {total}
            </span>
            <PageSizeSelect sizes={PAGE_SIZES} value={pageSize} />
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <PageArrow
                href={page > 1 ? `/contatos?${buildQuery({ ...filter, pageSize, page: page - 1 })}` : null}
                label="Página anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </PageArrow>
              <span className="num px-2">
                {page} de {totalPages}
              </span>
              <PageArrow
                href={page < totalPages ? `/contatos?${buildQuery({ ...filter, pageSize, page: page + 1 })}` : null}
                label="Próxima página"
              >
                <ChevronRight className="h-4 w-4" />
              </PageArrow>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PageArrow({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  const cls = "flex h-8 w-8 items-center justify-center rounded-md border border-line-strong text-foreground";
  if (!href) return <span className={cn(cls, "opacity-40")}>{children}</span>;
  return (
    <Link href={href} aria-label={label} className={cn(cls, "transition-colors hover:bg-accent")}>
      {children}
    </Link>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-small transition-colors",
        active ? "bg-brand-100 font-medium text-brand-500" : "text-ink-2 hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function TagChips({
  summary,
  activeTag,
  baseQuery,
}: {
  summary: { total: number; semTag: number; tags: { id: string; nome: string; cor: string | null; count: number }[] };
  activeTag?: string;
  baseQuery: Record<string, string | number | undefined>;
}) {
  const href = (params: Record<string, string | number | undefined>) =>
    `/contatos?${buildQuery({ ...baseQuery, ...params, page: undefined })}`;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-small text-ink-3">Tag</span>
      <Chip href={href({ tag: undefined })} active={!activeTag}>
        Todas <span className="num text-ink-3">{summary.total}</span>
      </Chip>
      <Chip href={href({ tag: TAG_NONE })} active={activeTag === TAG_NONE}>
        Sem tag <span className="num text-ink-3">{summary.semTag}</span>
      </Chip>
      {summary.tags.map((t) => (
        <Chip key={t.id} href={href({ tag: t.id })} active={activeTag === t.id}>
          {t.nome} <span className="num text-ink-3">{t.count}</span>
        </Chip>
      ))}
    </div>
  );
}

/**
 * Chips do agro: um tipo do verificador (a mesma coluna "Agro" da lista), "Não produtor" (rótulo do CNAE da
 * empresa) e "Sem classificação" (nenhum tipo). Um de cada vez: cada chip troca os dois filtros de uma vez.
 */
function AgroChips({ activeAgro, activeProdutor, baseQuery }: { activeAgro?: string; activeProdutor?: string; baseQuery: Record<string, string | number | undefined> }) {
  const opcoes: { label: string; agro?: string; produtor?: string }[] = [
    { label: "Todos" },
    ...AGRO_TIPOS.map((t) => ({ label: AGRO_ROTULO[t], agro: t })),
    { label: "Não produtor", produtor: "nao_produtor" },
    { label: "Sem classificação", agro: AGRO_SEM_TIPO },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-small text-ink-3">Agro</span>
      {opcoes.map((o) => (
        <Chip
          key={o.label}
          href={`/contatos?${buildQuery({ ...baseQuery, agro: o.agro, produtor: o.produtor, page: undefined })}`}
          active={activeAgro === o.agro && activeProdutor === o.produtor}
        >
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

function buildQuery(p: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  }
  return params.toString();
}
