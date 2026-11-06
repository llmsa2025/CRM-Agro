import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBackup, MOTIVOS, vigiaDoBackupLigado } from "./backup";

/**
 * Vigia do backup fora do servidor. Usa uma pasta temporária no lugar de /var/backups/crmagro/status e nunca
 * toca o ambiente do processo: o `env` e o relógio entram por parâmetro.
 */

const AGORA = new Date("2026-10-05T12:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "crmagro-backup-status-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ligado = (extra: Record<string, string> = {}) =>
  ({ BACKUP_FORA_VIGIAR: "1", BACKUP_STATUS_DIR: dir, ...extra }) as NodeJS.ProcessEnv;
const gravar = (arquivo: string, corpo: unknown) =>
  writeFile(join(dir, arquivo), typeof corpo === "string" ? corpo : JSON.stringify(corpo));
/** O formato exato que script de operação grava (gravar_status em lib/backup-fora-comum.sh). */
const copia = (
  ok: boolean,
  quando: string,
  motivo = "",
  ultimoSucesso: string | null = ok ? quando : null,
) => ({
  versao: 1,
  ok,
  quando,
  ultimoSucesso,
  motivo,
  destino: "s3",
  enviados: 2,
  jaNoDestino: 0,
  apagados: 0,
  bytes: 24_000_000,
  maisNovo: "crmagro-20261005-033011.dump.enc",
});

describe("vigia do backup fora do servidor", () => {
  it("desligado por padrão: devolve null e nem lê a pasta (o relatório de saúde fica como era)", async () => {
    expect(vigiaDoBackupLigado({} as NodeJS.ProcessEnv)).toBe(false);
    expect(vigiaDoBackupLigado({ BACKUP_FORA_VIGIAR: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(vigiaDoBackupLigado({ BACKUP_FORA_VIGIAR: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(vigiaDoBackupLigado({ BACKUP_FORA_VIGIAR: "1" } as NodeJS.ProcessEnv)).toBe(true);
    // Mesmo com tudo errado na pasta, desligado não avisa nada.
    await gravar("copia-fora.json", "lixo");
    expect(
      await checkBackup({ env: { BACKUP_STATUS_DIR: dir } as NodeJS.ProcessEnv, agora: AGORA }),
    ).toBeNull();
    expect(
      await checkBackup({
        env: { BACKUP_FORA_VIGIAR: "0", BACKUP_STATUS_DIR: dir } as NodeJS.ProcessEnv,
        agora: AGORA,
      }),
    ).toBeNull();
  });

  it("ligado e a cópia de 3 h atrás deu certo: saudável", async () => {
    await gravar("copia-fora.json", copia(true, horasAtras(3)));
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r).toMatchObject({ status: "healthy" });
    expect(r?.error).toBeUndefined();
  });

  it("ligado e sem arquivo de status: avisa que a cópia nunca rodou", async () => {
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.status).toBe("unhealthy");
    expect(r?.error).toMatch(/sem registro da cópia do backup/);
  });

  it("cópia velha demais (30 h, limite 26): problema, dizendo há quantas horas", async () => {
    await gravar("copia-fora.json", copia(true, horasAtras(30)));
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.status).toBe("unhealthy");
    expect(r?.error).toBe(
      "a cópia do backup para fora do servidor não roda há 30 h (limite de 26 h)",
    );
  });

  it("o limite de horas é configurável e um valor sem sentido cai no padrão", async () => {
    await gravar("copia-fora.json", copia(true, horasAtras(30)));
    expect(
      (await checkBackup({ env: ligado({ BACKUP_FORA_MAX_IDADE_H: "48" }), agora: AGORA }))?.status,
    ).toBe("healthy");
    expect(
      (await checkBackup({ env: ligado({ BACKUP_FORA_MAX_IDADE_H: "abc" }), agora: AGORA }))
        ?.status,
    ).toBe("unhealthy");
    expect(
      (await checkBackup({ env: ligado({ BACKUP_FORA_MAX_IDADE_H: "0" }), agora: AGORA }))?.status,
    ).toBe("unhealthy");
  });

  it("cópia que falhou: o motivo vem da tabela de textos e diz há quanto tempo foi a última boa", async () => {
    await gravar("copia-fora.json", copia(false, horasAtras(1), "envio_falhou", horasAtras(25)));
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.status).toBe("unhealthy");
    expect(r?.error).toBe(
      "a cópia do backup para fora do servidor falhou: o envio para o destino falhou, a última cópia boa foi há 25 h",
    );
  });

  it("cópia que falhou e nunca teve uma boa", async () => {
    await gravar("copia-fora.json", copia(false, horasAtras(1), "configuracao", null));
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.error).toBe(
      "a cópia do backup para fora do servidor falhou: a configuração da cópia está inválida, ainda não houve cópia boa",
    );
  });

  it("todo código de motivo que os scripts gravam tem texto, e código desconhecido não é repetido na saída", async () => {
    for (const codigo of Object.keys(MOTIVOS)) {
      await gravar("copia-fora.json", copia(false, horasAtras(1), codigo));
      const r = await checkBackup({ env: ligado(), agora: AGORA });
      expect(r?.error).toContain(MOTIVOS[codigo]!);
    }
    await gravar("copia-fora.json", copia(false, horasAtras(1), "bucket_secreto_do_cliente"));
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.error).toContain("motivo desconhecido");
    expect(r?.error).not.toContain("bucket_secreto_do_cliente");
  });

  it("os códigos que o script grava (sem dígito, só a-z e _) cobrem a tabela de textos", async () => {
    for (const codigo of Object.keys(MOTIVOS)) expect(codigo).toMatch(/^[a-z_]+$/);
  });

  it("arquivo ilegível ou com formato errado vira problema (nunca derruba o health)", async () => {
    await gravar("copia-fora.json", "{ isto nao e json");
    expect((await checkBackup({ env: ligado(), agora: AGORA }))?.error).toMatch(/ilegível/);
    await gravar("copia-fora.json", { ok: "sim", quando: horasAtras(1) });
    expect((await checkBackup({ env: ligado(), agora: AGORA }))?.error).toMatch(/ilegível/);
    await gravar("copia-fora.json", { ok: true, quando: "ontem" });
    expect((await checkBackup({ env: ligado(), agora: AGORA }))?.error).toMatch(/ilegível/);
  });

  it("pasta que não existe: problema, sem lançar erro", async () => {
    const r = await checkBackup({
      env: ligado({ BACKUP_STATUS_DIR: join(dir, "nao-existe") }),
      agora: AGORA,
    });
    expect(r?.status).toBe("unhealthy");
    expect(r?.error).toMatch(/sem registro/);
  });

  it("a mensagem nunca leva destino, host, bucket nem outro campo do arquivo", async () => {
    await gravar("copia-fora.json", {
      ...copia(false, horasAtras(1), "envio_falhou"),
      bucket: "meu-bucket-secreto",
      host: "10.0.0.7",
      erro: "SignatureDoesNotMatch AKIA123",
    });
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.error).not.toMatch(/bucket|10\.0\.0\.7|Signature|AKIA|s3/);
  });

  it("relógio adiantado em relação ao arquivo não vira idade negativa", async () => {
    await gravar(
      "copia-fora.json",
      copia(true, new Date(AGORA.getTime() + 3_600_000).toISOString()),
    );
    expect((await checkBackup({ env: ligado(), agora: AGORA }))?.status).toBe("healthy");
  });

  describe("conferência do destino (opcional)", () => {
    it("sem arquivo: ignora; ok: ignora; falha: problema que fica até a próxima rodada limpar", async () => {
      await gravar("copia-fora.json", copia(true, horasAtras(2)));
      expect((await checkBackup({ env: ligado(), agora: AGORA }))?.status).toBe("healthy");
      await gravar("conferencia-fora.json", {
        versao: 1,
        ok: true,
        quando: horasAtras(1),
        ultimoSucesso: horasAtras(1),
        motivo: "",
      });
      expect((await checkBackup({ env: ligado(), agora: AGORA }))?.status).toBe("healthy");
      await gravar("conferencia-fora.json", {
        versao: 1,
        ok: false,
        quando: horasAtras(100),
        ultimoSucesso: null,
        motivo: "ultimo_velho",
      });
      const r = await checkBackup({ env: ligado(), agora: AGORA });
      expect(r?.status).toBe("unhealthy");
      expect(r?.error).toBe(
        "a conferência do destino do backup achou problema: o último backup no destino está velho",
      );
    });
  });

  describe("teste de restauração (opcional)", () => {
    it("sem TESTE_MAX_DIAS: arquivo ausente ou antigo não incomoda; falha sempre incomoda", async () => {
      await gravar("copia-fora.json", copia(true, horasAtras(2)));
      expect((await checkBackup({ env: ligado(), agora: AGORA }))?.status).toBe("healthy");
      await gravar("restauracao-teste.json", {
        versao: 1,
        ok: true,
        quando: horasAtras(24 * 40),
        ultimoSucesso: horasAtras(24 * 40),
        motivo: "",
      });
      expect((await checkBackup({ env: ligado(), agora: AGORA }))?.status).toBe("healthy");
      await gravar("restauracao-teste.json", {
        versao: 1,
        ok: false,
        quando: horasAtras(2),
        ultimoSucesso: horasAtras(24 * 8),
        motivo: "base_vazia",
      });
      const r = await checkBackup({ env: ligado(), agora: AGORA });
      expect(r?.error).toBe(
        "o teste de restauração do backup falhou: o backup restaurou sem contatos",
      );
    });

    it("com TESTE_MAX_DIAS=10: exige um teste bom nos últimos 10 dias", async () => {
      const env = ligado({ BACKUP_FORA_TESTE_MAX_DIAS: "10" });
      await gravar("copia-fora.json", copia(true, horasAtras(2)));
      expect((await checkBackup({ env, agora: AGORA }))?.error).toBe(
        "ainda não há registro de teste de restauração do backup",
      );
      await gravar("restauracao-teste.json", {
        versao: 1,
        ok: true,
        quando: horasAtras(24 * 3),
        ultimoSucesso: horasAtras(24 * 3),
        motivo: "",
      });
      expect((await checkBackup({ env, agora: AGORA }))?.status).toBe("healthy");
      await gravar("restauracao-teste.json", {
        versao: 1,
        ok: true,
        quando: horasAtras(24 * 12),
        ultimoSucesso: horasAtras(24 * 12),
        motivo: "",
      });
      expect((await checkBackup({ env, agora: AGORA }))?.error).toBe(
        "o teste de restauração do backup não roda há 12 dias (limite de 10)",
      );
    });
  });

  it("vários problemas juntos saem numa mensagem só, separados por ponto e vírgula", async () => {
    await gravar(
      "copia-fora.json",
      copia(false, horasAtras(1), "destino_inacessivel", horasAtras(50)),
    );
    await gravar("restauracao-teste.json", {
      versao: 1,
      ok: false,
      quando: horasAtras(2),
      ultimoSucesso: null,
      motivo: "chave_ou_arquivo_ruim",
    });
    const r = await checkBackup({ env: ligado(), agora: AGORA });
    expect(r?.error?.split("; ")).toHaveLength(2);
  });

  it("o alerta que já existe transforma o problema num motivo com o nome `backup` (Web Push e e-mail)", async () => {
    await gravar("copia-fora.json", copia(true, horasAtras(30)));
    const backup = await checkBackup({ env: ligado(), agora: AGORA });
    const { motivosDoRelatorio } = await import("./alerta");
    const saudavel = { status: "healthy" as const, latency_ms: 1 };
    const motivos = motivosDoRelatorio({
      status: "degraded",
      timestamp: AGORA.toISOString(),
      uptime_seconds: 1,
      checks: {
        database: saudavel,
        redis: saudavel,
        evolution: saudavel,
        worker: saudavel,
        motor: {
          ...saudavel,
          filas: {},
          orfas: 0,
          falhasUltimaHora: 0,
          workers: [],
          motivos: [],
        } as never,
        emailPlataforma: saudavel,
        ...(backup ? { backup } : {}),
      },
    });
    expect(motivos).toEqual([
      {
        chave: "backup",
        texto: "backup: a cópia do backup para fora do servidor não roda há 30 h (limite de 26 h)",
        categoria: "backup",
      },
    ]);
  });
});
