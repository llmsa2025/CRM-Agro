/**
 * Regras PURAS da tela "Enriquecer pessoa": o que vem marcado, o pedido de busca e os textos. Sem
 * React e sem rede. O CPF digitado só serve para a consulta e nunca é mostrado inteiro.
 */

export type EmpresaDaTela = { id: string; confianca: "alta" | "media" | "baixa"; jaVinculada: boolean; ativa?: boolean };

/** Marcadas de saída: ativas, de confiança alta ou média e ainda não vinculadas. Baixa (só o CPF bate) e inativa NUNCA vêm marcadas. */
export function empresasMarcadasDeSaida(empresas: readonly EmpresaDaTela[]): Set<string> {
  return new Set(empresas.filter((e) => !e.jaVinculada && e.ativa !== false && e.confianca !== "baixa").map((e) => e.id));
}

export type DadoDeContatoDaTela = { id: string; tipo: "telefone" | "email" | "endereco"; provavelPessoal: boolean; jaNoCadastro: boolean };

/**
 * Telefone, e-mail e endereço que vêm marcados: só os de empresa de empresário individual ou MEI (em que o dado costuma ser
 * da própria pessoa) e que o contato ainda não tem. Dado de sociedade nunca vem marcado. Endereço: só o primeiro, porque
 * o cadastro guarda um só.
 */
export function contatosMarcadosDeSaida(dados: readonly DadoDeContatoDaTela[]): Set<string> {
  const marcados = new Set<string>();
  let temEndereco = false;
  for (const d of dados) {
    if (!d.provavelPessoal || d.jaNoCadastro) continue;
    if (d.tipo === "endereco") {
      if (temEndereco) continue;
      temEndereco = true;
    }
    marcados.add(d.id);
  }
  return marcados;
}

/** IE consultada com o CPF completo no cadastro de contribuintes: vem marcada. */
export function iesMarcadasDeSaida(ies: readonly { id: string }[]): Set<string> {
  return new Set(ies.map((i) => i.id));
}

export type FormularioDaPessoa = {
  cpf: string;
  nome: string;
  cidade: string;
  uf: string;
  email: string;
  telefone: string;
};

/** "123.456.789-01" enquanto digita. */
export function formatarCpf(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  const partes = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(".");
  return d.length > 9 ? `${partes}-${d.slice(9)}` : partes;
}

const palavras = (v: string) => v.trim().split(/\s+/).filter((p) => /\p{L}/u.test(p)).length;

/** Formulário → pedido. `temCpfNoCadastro`: o servidor usa o CPF cifrado do contato quando o campo está vazio. */
export function montarPedidoDaPessoa(
  f: FormularioDaPessoa,
  temCpfNoCadastro: boolean,
  opcoes: { incluirInativas?: boolean } = {},
): { ok: true; pedido: { cpf?: string; nome?: string; cidade?: string; uf?: string; email?: string; telefone?: string; incluirInativas?: boolean } } | { ok: false; erro: string } {
  const cpf = f.cpf.replace(/\D/g, "");
  if (!cpf && !temCpfNoCadastro) return { ok: false, erro: "Informe o CPF da pessoa para buscar as empresas dela." };
  if (cpf && cpf.length !== 11) return { ok: false, erro: "O CPF tem 11 dígitos." };
  if (f.nome.trim() && palavras(f.nome) < 2) return { ok: false, erro: "Informe nome e sobrenome." };
  if (f.cidade.trim() && !f.uf) return { ok: false, erro: "Escolha o estado da cidade." };
  return {
    ok: true,
    pedido: {
      ...(cpf ? { cpf } : {}),
      ...(f.nome.trim() ? { nome: f.nome.trim() } : {}),
      ...(f.cidade.trim() ? { cidade: f.cidade.trim() } : {}),
      ...(f.uf ? { uf: f.uf } : {}),
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
      ...(f.telefone.trim() ? { telefone: f.telefone.trim() } : {}),
      ...(opcoes.incluirInativas ? { incluirInativas: true } : {}),
    },
  };
}

export function textoDoAplicarPessoa(empresas: number, ies: number, contatos = 0): string {
  if (empresas + ies + contatos === 0) return "Nada marcado";
  const partes = [empresas ? `${empresas} ${empresas === 1 ? "empresa" : "empresas"}` : null, ies ? `${ies} ${ies === 1 ? "inscrição" : "inscrições"}` : null].filter(Boolean);
  if (!contatos) return `Vincular ${partes.join(" e ")}`;
  const dados = `${contatos} ${contatos === 1 ? "dado" : "dados"} de contato`;
  return partes.length ? `Vincular ${partes.join(" e ")} e acrescentar ${dados}` : `Acrescentar ${dados}`;
}

/** Texto do aviso depois de aplicar: o que entrou, em palavras. */
export function textoDoResultadoPessoa(r: { empresasVinculadas: number; iesGravadas: number; contatosAdicionados: number }): string {
  const partes = [
    r.empresasVinculadas ? `${r.empresasVinculadas} ${r.empresasVinculadas === 1 ? "empresa vinculada" : "empresas vinculadas"}` : null,
    r.iesGravadas ? `${r.iesGravadas} ${r.iesGravadas === 1 ? "inscrição vinculada" : "inscrições vinculadas"}` : null,
    r.contatosAdicionados ? `${r.contatosAdicionados} ${r.contatosAdicionados === 1 ? "dado de contato acrescentado" : "dados de contato acrescentados"}` : null,
  ].filter(Boolean);
  return partes.length ? partes.join(", ") : "Nada vinculado";
}
