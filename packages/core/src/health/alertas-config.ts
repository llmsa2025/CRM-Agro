import { basePrisma } from "@crmagro/db";
import { logger } from "../logger/index";
import { erroParaLog } from "../email/plataforma";

/**
 * Configuração dos alertas de saúde do servidor. É o que o motor de alertas (worker e `/api/health`) lê e grava por
 * conta própria.
 *
 * EXCEÇÃO DOCUMENTADA AO ISOLAMENTO POR TIME: os alertas são do servidor, não de um time. As tabelas `AlertaConfig`
 * (uma linha, id "plataforma") e `AlertaEnviado` não têm `teamId`, só o papel dono do banco as toca (`basePrisma`) e o
 * `crmagro_app` não tem privilégio nelas.
 *
 * REGRA: com a linha salva, ela vale. Sem ela, ou com o banco fora do ar (justamente quando o alerta mais importa),
 * vale o `.env` (ALERT_EMAILS e ALERT_TEAM_ID).
 */

/** Id fixo da linha única de configuração. */
export const ID_DA_CONFIG_DE_ALERTAS = "plataforma";

/** Motivos que a dona escolhe se alertam. Chave estável (vai para o banco), rótulo e descrição para a tela. */
export const MOTIVOS_DO_ALERTA = [
  {
    chave: "banco",
    rotulo: "Banco de dados",
    descricao: "O banco não responde. O CRM Agro fica fora do ar.",
  },
  {
    chave: "redis",
    rotulo: "Redis",
    descricao: "O Redis não responde. Filas e limites de uso param.",
  },
  {
    chave: "whatsapp",
    rotulo: "WhatsApp (Evolution)",
    descricao: "A Evolution não responde ou uma conta de WhatsApp está desconectada.",
  },
  {
    chave: "worker",
    rotulo: "Worker parado",
    descricao: "O processo que roda fluxos, IA e e-mail parou de dar sinal de vida.",
  },
  {
    chave: "motor_filas",
    rotulo: "Motor de fluxos atrasado",
    descricao:
      "A fila de fluxos ou a social está atrasada, ou chegaram mensagens que não foram gravadas.",
  },
  {
    chave: "motor_inscricoes",
    rotulo: "Inscrições seguradas ou órfãs",
    descricao: "Há contatos parados dentro de um fluxo que não andam sozinhos.",
  },
  {
    chave: "google_agenda",
    rotulo: "Agenda do Google",
    descricao: "O Google recusa as credenciais do CRM Agro e a agenda das pessoas não sincroniza.",
  },
  { chave: "backup", rotulo: "Backup fora do servidor", descricao: "A cópia do backup para fora do servidor não roda no prazo (só vigiada com BACKUP_FORA_VIGIAR=1)." },
  {
    chave: "email_plataforma",
    rotulo: "E-mail da plataforma",
    descricao: "O remetente dos e-mails do sistema está com o .env incompleto ou inválido.",
  },
] as const;

export type MotivoChave = (typeof MOTIVOS_DO_ALERTA)[number]["chave"];
export const CHAVES_DOS_MOTIVOS: readonly string[] = MOTIVOS_DO_ALERTA.map((m) => m.chave);

/** Menor espera entre dois avisos do mesmo motivo, em minutos (a base da espera crescente de 30 min, 2 h e 6 h). */
export const INTERVALOS_MINIMOS_MIN = [30, 120, 360] as const;
export const INTERVALO_PADRAO_MIN = 30;

/** Teto de endereços que recebem o alerta (é a operação, não uma lista de e-mail). */
export const MAX_EMAILS_DE_ALERTA = 10;

export type ConfigEfetiva = {
  /** De onde veio: a linha salva pela tela ou o `.env` (nunca salvou, ou banco fora). */
  origem: "tela" | "env";
  ligado: boolean;
  emails: string[];
  canais: { email: boolean; push: boolean };
  /** Chaves dos motivos que NÃO alertam. */
  motivosDesligados: string[];
  intervaloMinimoMin: number;
  /** Time de operação (Web Push e caixa do aviso sem remetente da plataforma). */
  timeOperacaoId: string | null;
};

/** Categoria do alerta de um motivo do relatório de saúde (a chave de `MOTIVOS_DO_ALERTA`). */
export function categoriaDoMotivo(nomeDoCheck: string, textoDoMotivo?: string): string {
  switch (nomeDoCheck) {
    case "database":
      return "banco";
    case "redis":
      return "redis";
    case "evolution":
      return "whatsapp";
    case "worker":
      return "worker";
    case "emailPlataforma":
      return "email_plataforma";
    case "backup":
      return "backup";
    case "motor":
      if (/google/i.test(textoDoMotivo ?? "")) return "google_agenda";
      return /inscri/i.test(textoDoMotivo ?? "") ? "motor_inscricoes" : "motor_filas";
    default:
      // Check novo ainda sem categoria: segue alertando (não dá para desligar o que não se conhece).
      return nomeDoCheck;
  }
}

/** Rótulo de uma categoria para a tela (o que não se conhece volta como está). */
export function rotuloDoMotivo(chave: string): string {
  return MOTIVOS_DO_ALERTA.find((m) => m.chave === chave)?.rotulo ?? chave;
}

/** Lista de e-mails do `.env` (ALERT_EMAILS): vírgula, sem validar (como sempre foi). */
export function emailsDoEnv(): string[] {
  return (process.env.ALERT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** O comportamento de antes da tela: tudo ligado, a lista e o time do `.env`. */
export function configDoEnv(): ConfigEfetiva {
  return {
    origem: "env",
    ligado: true,
    emails: emailsDoEnv(),
    canais: { email: true, push: true },
    motivosDesligados: [],
    intervaloMinimoMin: INTERVALO_PADRAO_MIN,
    timeOperacaoId: process.env.ALERT_TEAM_ID?.trim() || null,
  };
}

/**
 * A configuração em vigor AGORA: a linha da tela, se existe; senão o `.env`.
 * Nunca lança: banco fora = `.env` (o alerta de "banco fora" não pode depender
 * do banco para sair).
 */
export async function configEfetiva(): Promise<ConfigEfetiva> {
  try {
    const linha = await basePrisma.alertaConfig.findUnique({
      where: { id: ID_DA_CONFIG_DE_ALERTAS },
    });
    if (!linha) return configDoEnv();
    return {
      origem: "tela",
      ligado: linha.ligado,
      emails: linha.emails,
      canais: { email: linha.canalEmail, push: linha.canalPush },
      motivosDesligados: linha.motivosDesligados,
      intervaloMinimoMin: (INTERVALOS_MINIMOS_MIN as readonly number[]).includes(
        linha.intervaloMinimoMin,
      )
        ? linha.intervaloMinimoMin
        : INTERVALO_PADRAO_MIN,
      timeOperacaoId: linha.timeOperacaoId ?? (process.env.ALERT_TEAM_ID?.trim() || null),
    };
  } catch (e) {
    logger.warn(
      { err: erroParaLog(e) },
      "[alerta] configuração da tela indisponível: usando o .env",
    );
    return configDoEnv();
  }
}

/** Espera até o próximo aviso do MESMO motivo: o degrau da espera crescente, nunca abaixo do mínimo escolhido. Pura. */
export function esperaEmSegundos(degrauS: number, intervaloMinimoMin: number): number {
  return Math.max(degrauS, Math.max(1, intervaloMinimoMin) * 60);
}

// ─── Registro do que foi enviado ─────────────────────────────────────────────

export type RegistroDeAlerta = {
  canal: "email" | "push" | "teste";
  /** Categoria (`MOTIVOS_DO_ALERTA`) ou "teste". */
  motivo: string;
  /** Status do relatório de saúde ("degraded" | "unhealthy") ou "teste". */
  status: string;
  resultado: "enviado" | "falhou";
  destinatarios?: number;
};

/** Quanto tempo o registro de alertas fica (o suficiente para a tela e para um incidente). */
const RETENCAO_DOS_REGISTROS_DIAS = 90;

/**
 * Registra UM alerta (ou tentativa) enviado. Só categoria, canal, status e
 * resultado: nunca o texto do erro (pode trazer host do banco), o conteúdo do
 * e-mail nem o endereço de quem recebeu (só a quantidade). Nunca lança: o
 * registro não pode derrubar o alerta. Apaga de passagem o que passou da retenção.
 */
export async function registrarAlertaEnviado(r: RegistroDeAlerta): Promise<void> {
  try {
    await basePrisma.alertaEnviado.create({
      data: {
        canal: r.canal,
        motivo: r.motivo,
        status: r.status,
        resultado: r.resultado,
        destinatarios: r.destinatarios ?? 0,
      },
    });
    // Poda barata (índice em criadoEm): 1 em cada 20 registros.
    if (Math.random() < 0.05) {
      await basePrisma.alertaEnviado.deleteMany({
        where: {
          criadoEm: { lt: new Date(Date.now() - RETENCAO_DOS_REGISTROS_DIAS * 86_400_000) },
        },
      });
    }
  } catch (e) {
    logger.warn({ err: erroParaLog(e) }, "[alerta] registro do alerta não gravou");
  }
}
