import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HealthCheckResult } from "./check";

/**
 * Vigia do backup fora do servidor.
 *
 * Os scripts `script de operação`, `backup-conferir-fora.sh` e `backup-restaurar-teste.sh`
 * gravam, a cada rodada, um arquivo de status em `BACKUP_STATUS_DIR` (padrão `/var/backups/crmagro/status`):
 *   - `copia-fora.json`        a cópia diária para fora do servidor (obrigatório quando o vigia está ligado);
 *   - `conferencia-fora.json`  a conferência independente do destino (opcional);
 *   - `restauracao-teste.json` o teste de restauração em banco descartável (opcional).
 * Formato: `{ versao, ok, quando, ultimoSucesso, motivo, ...números }`. Só códigos, datas e contagens:
 * nenhum dado pessoal, nome de bucket, host nem mensagem de ferramenta. O texto que vai para o alerta
 * sai SEMPRE da tabela `MOTIVOS` daqui, nunca do conteúdo do arquivo.
 *
 * Ligado por `BACKUP_FORA_VIGIAR=1` (desligado por padrão: nada muda no relatório de saúde). Ligado, um
 * problema deixa o relatório `degraded`, e o alerta que já existe (Web Push e e-mail de `ALERT_EMAILS`,
 * `alerta.ts`) avisa sozinho, com o motivo. Não importa banco nem env validado: só lê arquivos.
 *
 * Variáveis (todas opcionais):
 *   BACKUP_FORA_VIGIAR=1             liga o vigia
 *   BACKUP_STATUS_DIR                pasta dos arquivos de status (padrão /var/backups/crmagro/status)
 *   BACKUP_FORA_MAX_IDADE_H          idade máxima da última cópia boa, em horas (padrão 26)
 *   BACKUP_FORA_TESTE_MAX_DIAS       se definido, exige um teste de restauração bem-sucedido a cada N dias
 */

export const STATUS_DIR_PADRAO = "/var/backups/crmagro/status";
const MAX_IDADE_H_PADRAO = 26;

/** Texto de cada código de motivo gravado pelos scripts. Código que não está aqui vira "motivo desconhecido". */
export const MOTIVOS: Record<string, string> = {
  configuracao: "a configuração da cópia está inválida",
  ferramenta_ausente: "falta uma ferramenta no servidor (rclone ou rsync)",
  sem_backup_local: "não há backup local para copiar",
  backup_local_velho: "o backup diário do servidor parou",
  arquivo_invalido: "um backup local não abre com a chave",
  destino_inacessivel: "o destino da cópia não responde",
  envio_falhou: "o envio para o destino falhou",
  verificacao_falhou: "o arquivo enviado não bateu na conferência",
  divergente: "já existe no destino um arquivo diferente com o mesmo nome",
  sem_backup_no_destino: "o destino está sem backup",
  ultimo_velho: "o último backup no destino está velho",
  conferencia_falhou: "a conferência do arquivo no destino falhou",
  chave_ou_arquivo_ruim: "o backup não abriu com a chave",
  restauracao_falhou: "o backup não restaurou",
  tabelas_ausentes: "faltam tabelas no backup restaurado",
  base_vazia: "o backup restaurou sem contatos",
  sha_diferente: "o arquivo baixado não bate com o sha256 do destino",
  download_falhou: "não foi possível baixar o backup do destino",
  docker_indisponivel: "o docker não está disponível para o teste",
};

interface StatusDoScript {
  ok: boolean;
  quando: Date;
  ultimoSucesso: Date | null;
  motivo: string;
}

type Leitura =
  { estado: "ausente" } | { estado: "ilegivel" } | { estado: "lido"; status: StatusDoScript };

async function lerStatus(dir: string, arquivo: string): Promise<Leitura> {
  let texto: string;
  try {
    texto = await readFile(join(dir, arquivo), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { estado: "ausente" }
      : { estado: "ilegivel" };
  }
  try {
    const bruto = JSON.parse(texto) as Record<string, unknown>;
    const quando = typeof bruto.quando === "string" ? new Date(bruto.quando) : null;
    if (typeof bruto.ok !== "boolean" || !quando || Number.isNaN(quando.getTime()))
      return { estado: "ilegivel" };
    const ultimo = typeof bruto.ultimoSucesso === "string" ? new Date(bruto.ultimoSucesso) : null;
    return {
      estado: "lido",
      status: {
        ok: bruto.ok,
        quando,
        ultimoSucesso: ultimo && !Number.isNaN(ultimo.getTime()) ? ultimo : null,
        motivo: typeof bruto.motivo === "string" ? bruto.motivo : "",
      },
    };
  } catch {
    return { estado: "ilegivel" };
  }
}

function textoDoMotivo(codigo: string): string {
  return MOTIVOS[codigo] ?? "motivo desconhecido";
}

const horasEntre = (agora: Date, antes: Date): number =>
  Math.max(0, (agora.getTime() - antes.getTime()) / 3_600_000);
const arredonda = (h: number): number => Math.round(h);

/** O vigia está ligado? Só com BACKUP_FORA_VIGIAR=1 (qualquer outro valor, inclusive vazio, é desligado). */
export function vigiaDoBackupLigado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BACKUP_FORA_VIGIAR === "1";
}

export interface OpcoesDoVigiaDoBackup {
  agora?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Confere os arquivos de status do backup fora do servidor. Devolve `null` com o vigia desligado (o relatório
 * de saúde fica exatamente como era). Ligado, devolve `healthy` ou `unhealthy` com os problemas no `error`.
 */
export async function checkBackup(
  op: OpcoesDoVigiaDoBackup = {},
): Promise<HealthCheckResult | null> {
  const env = op.env ?? process.env;
  if (!vigiaDoBackupLigado(env)) return null;
  const inicio = Date.now();
  const agora = op.agora ?? new Date();
  const dir = env.BACKUP_STATUS_DIR?.trim() || STATUS_DIR_PADRAO;
  const maxIdadeBruto = Number(env.BACKUP_FORA_MAX_IDADE_H);
  const maxIdadeH =
    Number.isFinite(maxIdadeBruto) && maxIdadeBruto >= 1 && maxIdadeBruto <= 720
      ? maxIdadeBruto
      : MAX_IDADE_H_PADRAO;
  const testeBruto = Number(env.BACKUP_FORA_TESTE_MAX_DIAS);
  const testeMaxDias = Number.isFinite(testeBruto) && testeBruto >= 1 ? testeBruto : null;

  const problemas: string[] = [];

  // 1) A cópia diária para fora: obrigatória quando o vigia está ligado.
  const copia = await lerStatus(dir, "copia-fora.json");
  if (copia.estado === "ausente") {
    problemas.push(
      "sem registro da cópia do backup para fora do servidor (o cron ainda não rodou ou não está instalado)",
    );
  } else if (copia.estado === "ilegivel") {
    problemas.push("o registro da cópia do backup para fora do servidor está ilegível");
  } else if (!copia.status.ok) {
    const ultimo = copia.status.ultimoSucesso;
    const quando = ultimo
      ? `, a última cópia boa foi há ${arredonda(horasEntre(agora, ultimo))} h`
      : ", ainda não houve cópia boa";
    problemas.push(
      `a cópia do backup para fora do servidor falhou: ${textoDoMotivo(copia.status.motivo)}${quando}`,
    );
  } else {
    const idade = horasEntre(agora, copia.status.ultimoSucesso ?? copia.status.quando);
    if (idade > maxIdadeH) {
      problemas.push(
        `a cópia do backup para fora do servidor não roda há ${arredonda(idade)} h (limite de ${maxIdadeH} h)`,
      );
    }
  }

  // 2) A conferência do destino: opcional (só vale se alguém já rodou), e uma falha fica até a próxima rodada limpar.
  const conferencia = await lerStatus(dir, "conferencia-fora.json");
  if (conferencia.estado === "ilegivel") {
    problemas.push("o registro da conferência do destino do backup está ilegível");
  } else if (conferencia.estado === "lido" && !conferencia.status.ok) {
    problemas.push(
      `a conferência do destino do backup achou problema: ${textoDoMotivo(conferencia.status.motivo)}`,
    );
  }

  // 3) O teste de restauração: uma falha sempre vale; a exigência de rodar de tempos em tempos só com TESTE_MAX_DIAS.
  const restauracao = await lerStatus(dir, "restauracao-teste.json");
  if (restauracao.estado === "ilegivel") {
    problemas.push("o registro do teste de restauração do backup está ilegível");
  } else if (restauracao.estado === "lido" && !restauracao.status.ok) {
    problemas.push(
      `o teste de restauração do backup falhou: ${textoDoMotivo(restauracao.status.motivo)}`,
    );
  } else if (testeMaxDias !== null) {
    if (restauracao.estado === "ausente") {
      problemas.push("ainda não há registro de teste de restauração do backup");
    } else if (restauracao.estado === "lido") {
      const dias =
        horasEntre(agora, restauracao.status.ultimoSucesso ?? restauracao.status.quando) / 24;
      if (dias > testeMaxDias) {
        problemas.push(
          `o teste de restauração do backup não roda há ${arredonda(dias)} dias (limite de ${testeMaxDias})`,
        );
      }
    }
  }

  const latency_ms = Date.now() - inicio;
  if (problemas.length === 0) return { status: "healthy", latency_ms };
  return { status: "unhealthy", latency_ms, error: problemas.join("; ") };
}
