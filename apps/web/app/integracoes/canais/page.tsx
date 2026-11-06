import { currentUser, runAsUser } from "@/lib/tenant";
import { db } from "@crmagro/db";
import {
  can,
  caixaComSenhaDoMesmoEndereco,
  entradaDeEmailLigada,
  envioPeloGmailParaMim,
  escopoCanal,
  getAccountRateStatus,
  lerEstadoHistorico,
  listarPessoasDoTime,
  listSignatures,
  linkedinConfigurado,
  minhaConexaoGoogle,
  obterEncaminhamento,
  podeConectarLinkedin,
  situacaoDaValidade,
} from "@crmagro/core";
import { CanaisClient, type ChannelAccountDTO } from "./CanaisClient";
import { canalDaUrl, contasDeIntegracoes } from "./abas";
import type { EstadoDoRecebimento } from "./encaminhamento";

export const dynamic = "force-dynamic";

export default async function CanaisPage({ searchParams }: { searchParams: Promise<{ canal?: string | string[]; google?: string | string[]; linkedin?: string | string[] }> }) {
  const { canal, google, linkedin } = await searchParams;
  const linkedinLigado = linkedinConfigurado();
  // Quem está na tela: a conexão automática de Instagram/LinkedIn manda isto à
  // extensão, e o servidor confere que o token dela é da MESMA pessoa.
  const usuario = await currentUser();
  const { accounts, transferirPara, assinaturas, envioGmail, enderecoGoogle, senhaNoEnderecoDoGoogle, recebimento, podeConectarLinkedin: podeLinkedin } = await runAsUser(async () => {
    const [todas, pessoas, assinaturas, envioGmail] = await Promise.all([
      db().channelAccount.findMany({
        where: escopoCanal(), // F3: os números que a pessoa vê
        orderBy: { createdAt: "asc" },
        select: { id: true, canal: true, label: true, provider: true, status: true, ownerId: true, meta: true },
      }),
      listarPessoasDoTime("conversas"),
      // Assinaturas por caixa (28/09): a aba E-mail mostra as de cada caixa.
      listSignatures(),
      // Envio pelo Gmail (E7b): o botão "Conectar Gmail" só aparece em "pode-conectar".
      envioPeloGmailParaMim().catch(() => "desligado" as const),
    ]);
    // LinkedIn: só a conta oficial (entrar e publicar) e só com o app configurado; sem isso a aba fica "Em breve".
    const rows = contasDeIntegracoes(todas, linkedinLigado);
    const nomeDe = new Map(pessoas.map((p) => [p.id, p.nome]));
    // Status de cota/aquecimento por conta (controle de ritmo Fase B).
    const accounts = (await Promise.all(
      rows.map(async ({ ownerId, meta, ...r }) => ({
        ...r,
        // Progresso da importação do histórico do WhatsApp (guardado no meta da conta).
        history: lerEstadoHistorico(meta),
        // Dono (F3d): quem vê o número além do master/admin/"ver tudo".
        donoNome: ownerId ? (nomeDe.get(ownerId) ?? null) : null,
        ownerId,
        rate: r.provider === "linkedin_official" ? null : await getAccountRateStatus(r.id),
        // LinkedIn oficial: quanto falta para o token vencer (o LinkedIn não renova sozinho).
        validade: r.provider === "linkedin_official" ? situacaoDaValidade(meta) : null,
      })),
    )) as ChannelAccountDTO[];
    const transferirPara = can("records.transfer")
      ? pessoas.filter((p) => p.ativo).map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }))
      : [];
    // Pop-up "Conectar e-mail": o Gmail sem senha usa a mesma conta Google da Agenda. Se esse endereço já tem
    // caixa com senha de app, a opção fica bloqueada (um endereço usa só uma forma). Só lê quando o envio está ligado.
    const enderecoGoogle = envioGmail === "desligado" ? null : ((await minhaConexaoGoogle().catch(() => null))?.email ?? null);
    const senhaNoEnderecoDoGoogle = enderecoGoogle ? await caixaComSenhaDoMesmoEndereco(enderecoGoogle).catch(() => false) : false;
    // Recebimento por encaminhamento das caixas do Gmail sem senha: a linha da caixa diz o que falta.
    const recebimento: Record<string, EstadoDoRecebimento> = {};
    if (entradaDeEmailLigada() !== null) {
      await Promise.all(
        rows
          .filter((r) => r.canal === "email" && r.provider === "gmail_api")
          .map(async (r) => {
            const dto = await obterEncaminhamento(r.id).catch(() => null);
            recebimento[r.id] = dto?.estado ?? "sem_endereco";
          }),
      );
    }
    return { accounts, transferirPara, assinaturas, envioGmail, enderecoGoogle, senhaNoEnderecoDoGoogle, recebimento, podeConectarLinkedin: podeConectarLinkedin() };
  });

  // `?canal=` (vindo do card de Integrações) abre a aba do canal. O cabeçalho
  // (trilha "Integrações / Canais /" + título do canal) mora no cliente:
  // acompanha a aba sem recarregar a página.
  return (
    <CanaisClient
      accounts={accounts}
      transferirPara={transferirPara}
      assinaturas={assinaturas}
      canalInicial={canalDaUrl(canal)}
      identidade={usuario ? { userId: usuario.id, teamId: usuario.teamId } : null}
      // Só o booleano vai ao cliente: o segredo da entrada nunca sai do servidor.
      recebeSemSenha={entradaDeEmailLigada() !== null}
      envioGmail={envioGmail}
      enderecoGoogle={enderecoGoogle}
      senhaNoEnderecoDoGoogle={senhaNoEnderecoDoGoogle}
      recebimento={recebimento}
      // A volta do Google: o servidor lê o `?google=` e o cliente mostra o aviso uma vez (sem `useSearchParams`).
      google={Array.isArray(google) ? (google[0] ?? null) : (google ?? null)}
      // LinkedIn oficial: ligado quando o app do LinkedIn está configurado; a volta dele usa o `?linkedin=`.
      linkedinLigado={linkedinLigado}
      podeConectarLinkedin={podeLinkedin}
      linkedin={Array.isArray(linkedin) ? (linkedin[0] ?? null) : (linkedin ?? null)}
    />
  );
}
