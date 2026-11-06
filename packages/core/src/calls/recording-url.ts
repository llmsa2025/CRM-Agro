/**
 * URL de gravação de ligação (auditoria S13). Vem do webhook da Voopi e é
 * baixada pelo serviço de transcrição — URL arbitrária seria SSRF a partir do
 * VPS. Só aceita `https:` em host da Voopi (ou os listados em
 * VOOPI_RECORDING_HOSTS, separados por vírgula; casa o domínio e subdomínios).
 */
const HOSTS_PADRAO = ["voopi.com.br"];

function hostsPermitidos(): string[] {
  const env = process.env.VOOPI_RECORDING_HOSTS?.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return env && env.length ? env : HOSTS_PADRAO;
}

export function gravacaoPermitida(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return hostsPermitidos().some((d) => host === d || host.endsWith(`.${d}`));
}
