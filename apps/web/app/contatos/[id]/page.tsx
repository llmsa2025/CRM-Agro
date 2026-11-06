import { runAsUser } from "@/lib/tenant";
import { notFound } from "next/navigation";

import {
  ContactNotFound,
  getById,
  listDealsByContact,
  listFunnels,
  listCompaniesForContact,
  listEmailsForContact,
  primaryEmail,
  primaryTelefone,
  lerCpf,
  signedMediaUrl,
  can,
  escopoDoAtor,
  getActor,
  listarPessoasDoTime,
  agroTiposValidos,
  lerAgroDetalhe,
  tagsDoContato,
  unirNomesDeTag,
} from "@crmagro/core";
import { ContactDetail, type Activity, type Contact, type CompanyItem, type DealItem } from "./ContactDetail";
import type { AgroDaFicha } from "./AgroDoContato";
import type { FunnelOption } from "@/components/add-to-funnel-dialog";
import { ContactActions } from "./forms";
import { proveniencia } from "@/lib/proveniencia-empresa";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/** Só o que a ficha mostra do Json de verificação: lido com zod, sem a leitura crua da foto. */
function agroDaFicha(tipos: string[], bruto: unknown): AgroDaFicha {
  const d = lerAgroDetalhe(bruto);
  return {
    tipos: agroTiposValidos(tipos),
    detalhe: d
      ? { origem: d.origem, verificadoEm: d.verificadoEm, foto: d.foto?.estado ?? null, evidencias: d.evidencias.map((e) => ({ tipo: e.tipo, fonte: e.fonte, peso: e.peso, texto: e.texto })) }
      : null,
  };
}

export default async function DetalhePage({ params }: { params: Params }) {
  const { id } = await params;

  let contact;
  let deals;
  let funnels;
  let companies;
  let emails;
  let pessoas;
  let quem;
  let tagsDoCatalogo;
  try {
    [contact, deals, funnels, companies, emails, pessoas, quem, tagsDoCatalogo] = await runAsUser(async () =>
      Promise.all([
        getById(id),
        listDealsByContact(id),
        listFunnels(),
        listCompaniesForContact(id),
        listEmailsForContact(id),
        listarPessoasDoTime("contatos"),
        // Quem pede (F3d/F4): vê tudo? é admin? — decide o menu de dono.
        Promise.resolve({ eu: getActor()?.userId ?? null, veTudo: escopoDoAtor("contatos", { escrita: true }).tudo, transfere: can("records.transfer"), escreve: can("contacts.write") }),
        // Tags do catálogo (as que a barra de filtro da lista lê); o campo legado entra junto abaixo.
        tagsDoContato(id),
      ]),
    );
  } catch (e) {
    if (e instanceof ContactNotFound) notFound();
    throw e;
  }

  const companyItems: CompanyItem[] = companies.map((c) => ({
    ...proveniencia(c.enrichment),
    id: c.id,
    papel: c.papel,
    nome: c.nome,
    cnpj: c.cnpj,
    ie: c.ie,
    site: c.site,
    email: c.email,
    telefone: c.telefone,
    endereco: c.endereco,
    cidade: c.cidade,
    estado: c.estado,
    instagram: c.instagram,
    linkedin: c.linkedin,
    naturezaJuridica: c.naturezaJuridica,
  }));

  const funnelOptions: FunnelOption[] = funnels.items.map((f) => ({
    id: f.id,
    nome: f.nome,
    stages: f.stages.map((s) => ({ id: s.id, nome: s.nome })),
  }));

  const contactProp: Contact = {
    id: contact.id,
    nome: contact.nome,
    email: primaryEmail(contact.identifiers),
    telefone: primaryTelefone(contact.identifiers),
    relacionamentoStatus: contact.relacionamentoStatus,
    interesse: contact.interesse,
    produtorLabel: contact.produtorLabel,
    cidade: contact.cidade,
    estado: contact.estado,
    endereco: contact.endereco,
    cargo: contact.cargo,
    origem: contact.origem,
    sobrenome: contact.sobrenome,
    cpf: lerCpf(contact.cpfCifrado),
    instagram: contact.identifiers.find((i) => i.canal === "instagram")?.valor ?? null,
    linkedin: contact.identifiers.find((i) => i.canal === "linkedin")?.valor ?? null,
    // Catálogo primeiro e, depois, o que só existe no campo legado: a ficha e o campo "Tags" mostram o mesmo.
    tags: unirNomesDeTag(tagsDoCatalogo, contact.tags),
    createdAt: contact.createdAt.toISOString(),
    areaHa: contact.areaHa,
    faturamentoAnual: contact.faturamentoAnual,
    camada: contact.camada ? { nome: contact.camada.nome, cor: contact.camada.cor } : null,
    // Responsável (obrigatório — regra do dono, 28/09): quem cuida do contato.
    donoNome: contact.owner?.name ?? null,
    compartilhado: contact.compartilhado,
    agro: agroDaFicha(contact.agroTipos, contact.agroDetalhe),
  };

  const activities: Activity[] = await Promise.all(
    contact.activities.map(async (a) => ({
      id: a.id,
      tipo: a.tipo,
      direcao: a.direcao,
      conteudo: a.conteudo,
      mediaUrl: a.mediaPath ? await signedMediaUrl(a.mediaPath) : null,
      mediaMime: a.mediaMime,
      meta: a.meta as Record<string, unknown> | null,
      createdAt: a.createdAt.toISOString(),
    })),
  );

  const dealItems: DealItem[] = deals.map((d) => ({
    id: d.id,
    funnelId: d.funnelId,
    valor: d.valor.toString(),
    status: d.status,
    enteredStageAt: d.enteredStageAt.toISOString(),
    stage: { nome: d.stage.nome, funnel: { nome: d.stage.funnel.nome } },
  }));

  return (
    <ContactDetail
      contact={contactProp}
      companies={companyItems}
      emails={emails}
      activities={activities}
      deals={dealItems}
      funnels={funnelOptions}
      podeMarcarStatus={quem.escreve}
      actions={
        <ContactActions
          contact={{
            id: contactProp.id,
            nome: contactProp.nome,
            sobrenome: contactProp.sobrenome,
            email: contactProp.email,
            telefone: contactProp.telefone,
            cidade: contactProp.cidade,
            estado: contactProp.estado,
            empresa: contact.empresa,
            cargo: contactProp.cargo,
            origem: contactProp.origem,
            tags: contactProp.tags,
            areaHa: contact.areaHa,
            faturamentoAnual: contact.faturamentoAnual,
          }}
          dono={{
            compartilhado: contact.compartilhado,
            podeCompartilhar: quem.veTudo || (quem.eu !== null && contact.ownerId === quem.eu),
            transferirPara: quem.transfere
              ? pessoas.filter((p) => p.ativo && p.id !== contact.ownerId).map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }))
              : [],
          }}
        />
      }
    />
  );
}
