import { runAsUser, currentUser } from "@/lib/tenant";
import { listCampaigns, editaTudoNaTela } from "@crmagro/core";
import { CampanhasLista } from "./CampanhasLista";

export const dynamic = "force-dynamic";

/** Campanhas (produto §A): lista com contadores por status. */
export default async function CampanhasPage() {
  const usuario = await currentUser();
  const campanhas = await runAsUser(async () => listCampaigns({ take: 100 }));
  // F4: quem pode abrir/fechar uma campanha para o time — quem criou ou quem vê o time todo.
  // Abrir/fechar para o time é ALTERAR: quem edita as de todos ("Ver e editar de todos").
  const veTudo = editaTudoNaTela(usuario?.role, usuario?.editarTudoEm, "campanhas");
  return <CampanhasLista campanhas={campanhas} podeEditar={usuario?.role !== "viewer"} eu={usuario?.id ?? null} veTudo={veTudo} />;
}
