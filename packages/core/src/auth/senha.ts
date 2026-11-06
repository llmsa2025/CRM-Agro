import { SENHA_MIN } from "./invites";

/**
 * Regras de senha NOVA para quem cria a conta sozinho (cadastro de empresa com
 * e-mail e senha — `cadastro-com-senha.ts`). Não é medidor de força: é a
 * barreira contra o óbvio, com mensagem clara do que mudar.
 *
 * Recusa:
 * - menos de `SENHA_MIN` (8) ou mais de `SENHA_MAX` caracteres;
 * - igual ao e-mail, à parte antes do @, ao nome da pessoa ou ao da empresa
 *   (ou um deles + um sufixo curto, como "joao123");
 * - um caractere repetido ("aaaaaaaa"), sequência ("12345678", "abcdefgh",
 *   "87654321") ou fileira do teclado ("qwertyui", "asdfghjk");
 * - senha comum de vazamento ("senha123", "password1", "mudar123", "CRM Agro@2026").
 *
 * A comparação ignora maiúsculas, espaços e pontuação ("Joao.Silva" = "joaosilva").
 */

/**
 * Máximo aceito. O bcrypt só usa os primeiros 72 bytes; 128 caracteres cobre
 * frase-senha longa sem aceitar um texto gigante no formulário.
 */
export const SENHA_MAX = 128;

/** Palavras-base de senha comum: a senha é uma delas + números/símbolos. */
const BASES_COMUNS = [
  "senha",
  "password",
  "passw0rd",
  "pass",
  "qwerty",
  "admin",
  "administrador",
  "crmagro",
  "crmagro",
  "brasil",
  "mudar",
  "trocar",
  "mudarsenha",
  "teste",
  "iloveyou",
  "welcome",
  "bemvindo",
  "abc",
  "abcd",
  "abcdef",
  "agro",
  "fazenda",
  "empresa",
  "usuario",
  "login",
  "entrar",
];

/** Senhas inteiras comuns que não caem nas outras regras. */
const SENHAS_COMUNS = new Set([
  "iloveyou",
  "princess",
  "sunshine",
  "football",
  "baseball",
  "dragon12",
  "monkey12",
  "flamengo",
  "corinthians",
  "palmeiras",
  "saopaulo",
  "vasco123",
  "gremio123",
  "internacional",
  "cruzeiro",
  "botafogo",
  "santos123",
  "jesus123",
  "deusefiel",
  "amor1234",
  "meuamor",
  "felicidade",
  "estrela1",
  "q1w2e3r4",
  "1q2w3e4r",
  "a1b2c3d4",
  "1a2b3c4d",
  "zaq12wsx",
  "!qaz2wsx",
  "1qaz2wsx",
]);

const FILEIRAS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "0987654321"];

/** Minúsculo, sem acento, só letras e dígitos. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** "12345678", "abcdefgh", "87654321", "aaaaaaaa": passo constante de -1, 0 ou +1. */
function ehSequencia(s: string): boolean {
  if (s.length < 3) return true;
  const passo = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(passo) > 1) return false;
  for (let i = 2; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== passo) return false;
  return true;
}

/** Trecho de uma fileira do teclado (ou dela ao contrário). */
function ehFileiraDoTeclado(s: string): boolean {
  if (s.length < 4) return false;
  return FILEIRAS.some((f) => f.includes(s) || [...f].reverse().join("").includes(s));
}

/** O que sobra é trivial: vazio, curto, só repetição ou sequência. */
function sobraTrivial(s: string): boolean {
  return s.length < 4 || ehSequencia(s) || ehFileiraDoTeclado(s);
}

/** A senha é `palavra` + um sufixo/prefixo trivial ("joao123", "123joao", "CRM Agro@2026")? */
function ehPalavraMaisTrivial(senha: string, palavra: string): boolean {
  if (palavra.length < 3) return false;
  if (senha === palavra) return true;
  if (senha.startsWith(palavra)) return sobraTrivial(senha.slice(palavra.length)) || /^\d{1,4}$/.test(senha.slice(palavra.length));
  if (senha.endsWith(palavra)) return sobraTrivial(senha.slice(0, -palavra.length)) || /^\d{1,4}$/.test(senha.slice(0, -palavra.length));
  return false;
}

export type ContextoDaSenha = {
  email?: string | null;
  /** Nome da pessoa, da empresa… — a senha não pode ser um deles. */
  nomes?: Array<string | null | undefined>;
};

/**
 * Por que a senha NÃO serve (mensagem pronta para a tela), ou `null` se serve.
 */
export function motivoSenhaFraca(senha: string, ctx: ContextoDaSenha = {}): string | null {
  const bruta = senha ?? "";
  if (bruta.length < SENHA_MIN) return `A senha precisa ter ao menos ${SENHA_MIN} caracteres.`;
  if (bruta.length > SENHA_MAX) return `A senha pode ter no máximo ${SENHA_MAX} caracteres.`;
  const s = normalizar(bruta);

  const email = (ctx.email ?? "").trim().toLowerCase();
  const pessoais = [email, email.split("@")[0] ?? "", ...(ctx.nomes ?? []).map((n) => n ?? "")]
    .map(normalizar)
    .filter((p) => p.length >= 3);
  // Nome composto: cada parte também conta ("Maria Aparecida" → "maria", "aparecida").
  for (const n of ctx.nomes ?? []) {
    for (const parte of (n ?? "").split(/\s+/)) {
      const p = normalizar(parte);
      if (p.length >= 4) pessoais.push(p);
    }
  }
  if (pessoais.some((p) => ehPalavraMaisTrivial(s, p))) {
    return "A senha não pode ser o seu e-mail, o seu nome ou o nome da empresa (nem eles com números no fim).";
  }

  if (s.length === 0 || /^(.)\1+$/.test(s) || ehSequencia(s) || ehFileiraDoTeclado(s)) {
    return "Essa senha é fácil de adivinhar (sequência ou repetição). Misture palavras, números e símbolos.";
  }
  if (SENHAS_COMUNS.has(s) || BASES_COMUNS.some((b) => ehPalavraMaisTrivial(s, b))) {
    return "Essa senha é muito comum. Use uma frase ou misture palavras que só você conheça.";
  }
  // Só dígitos: data de nascimento, telefone, CPF — fácil de descobrir.
  if (/^\d+$/.test(bruta.replace(/[\s./-]/g, "")) && bruta.replace(/[\s./-]/g, "").length < 12) {
    return "Uma senha só de números é fácil de adivinhar (data, telefone, CPF). Acrescente letras.";
  }
  return null;
}
