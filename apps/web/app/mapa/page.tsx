import { runAsUser, currentUser } from "@/lib/tenant";
import { listCampaigns, listTags } from "@crmagro/core";
import { MapaClient } from "./MapaClient";
import { temTela } from "@/lib/telas";

export const dynamic = "force-dynamic";

/**
 * Mapa (produto §B): onde estão os contatos, com filtros e o resumo da região
 * visível. Os pontos vêm de /api/mapa/* no cliente (viewport = região).
 */
export default async function MapaPage() {
  const usuario = await currentUser();
  const { tags, campanhas } = await runAsUser(async () => {
    // Nomes das campanhas no filtro só para quem tem a tela Campanhas (F2b).
    const veCampanhas = temTela(usuario?.role, usuario?.modulos, "campanhas");
    const [t, c] = await Promise.all([listTags(), veCampanhas ? listCampaigns({ take: 100 }) : Promise.resolve([])]);
    return {
      tags: t.map((x) => ({ id: x.id, nome: x.nome })),
      campanhas: c.filter((x) => x.status !== "draft").map((x) => ({ id: x.id, nome: x.nome })),
    };
  });
  // "Criar campanha" só para quem tem a tela Campanhas (F2b): as actions dela conferem.
  const podeCampanhas = usuario?.role !== "viewer" && temTela(usuario?.role, usuario?.modulos, "campanhas");
  return <MapaClient tags={tags} campanhas={campanhas} podeEditar={usuario?.role !== "viewer"} podeCampanhas={podeCampanhas} />;
}
