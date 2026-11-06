"use client";

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Mail, MailCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleIcon } from "@/components/google-icon";
import { criarEmpresaAction, type EstadoDoCadastro } from "./actions";

type Via = "senha" | "google";

/** Os campos de texto que a tela guarda enquanto a pessoa troca de opção (as senhas não). */
type Campos = Record<"empresa" | "cidade" | "estado" | "cnpj" | "nome" | "email", string>;

const NOME_DA_VIA: Record<Via, string> = { senha: "Registrar com e-mail", google: "Registrar com Google" };

/**
 * Formulário de /criar-empresa. A tela começa com dois botões iguais —
 * "Registrar com e-mail" e "Registrar com Google" — e, ao escolher, abrem ali
 * mesmo só os campos daquela opção:
 * - e-mail: empresa, pessoa (nome e e-mail) e senha;
 * - Google: só a empresa (o Google prova o e-mail).
 * "Trocar" volta à escolha sem apagar o que foi digitado. Se só uma opção estiver
 * disponível (Google sem remetente de e-mail, ou o contrário), a tela já abre nela.
 * A opção com senha só existe quando o servidor diz que dá para confirmar o
 * e-mail (`comSenha`).
 *
 * `useActionState`: um erro volta para o formulário SEM apagar o que foi
 * digitado (menos as senhas, que nunca voltam do servidor) e SEM fechar a
 * opção escolhida (`estado.via`).
 */
export function CriarEmpresaForm({ google, comSenha, erroInicial }: { google: boolean; comSenha: boolean; erroInicial: string | null }) {
  const [estado, acao, enviando] = useActionState<EstadoDoCadastro, FormData>(criarEmpresaAction, { valores: {}, erro: erroInicial ?? undefined });
  const v = estado.valores;

  // Só uma opção disponível: a tela abre direto nela, sem escolha e sem "Trocar".
  const unica: Via | null = google && comSenha ? null : google ? "google" : comSenha ? "senha" : null;
  const [via, setVia] = useState<Via | null>(estado.via ?? unica);
  useEffect(() => {
    if (estado.via) setVia(estado.via);
  }, [estado.via]);

  // Foco do teclado ao voltar por "Trocar": o botão clicado sai da tela junto com o
  // formulário e o foco cairia no <body>. `voltouPorTrocar` só liga no clique de
  // "Trocar" (nunca no primeiro render, para não roubar o foco ao abrir a página);
  // o efeito leva o foco ao primeiro botão de escolha e desliga a marca.
  const primeiraEscolha = useRef<HTMLButtonElement>(null);
  const voltouPorTrocar = useRef(false);
  useEffect(() => {
    if (via === null && voltouPorTrocar.current) {
      voltouPorTrocar.current = false;
      primeiraEscolha.current?.focus();
    }
  }, [via]);

  // Os textos ficam AQUI (campos controlados), não no formulário: ao voltar à
  // escolha o formulário sai da tela, e o que foi digitado sobreviveria só assim.
  const [campos, setCampos] = useState<Campos>({
    empresa: v.empresa ?? "",
    cidade: v.cidade ?? "",
    estado: v.estado ?? "",
    cnpj: v.cnpj ?? "",
    nome: v.nome ?? "",
    email: v.email ?? "",
  });
  const ligar = (campo: keyof Campos) => ({
    value: campos[campo],
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const valor = e.target.value;
      setCampos((c) => ({ ...c, [campo]: valor }));
    },
  });

  const invalido = (campo: string) => (estado.campo === campo ? true : undefined);
  const erroCls = "aria-[invalid=true]:border-danger-500";

  // O erro pertence à opção que o gerou: quem trocou de opção não vê, por
  // exemplo, "senha fraca" embaixo do formulário do Google. O `erroInicial`
  // (vem da URL, sem opção) aparece em qualquer tela.
  const erro = estado.erro && (estado.via === undefined || estado.via === via) ? estado.erro : undefined;
  const mensagemDeErro = erro && (
    <p role="alert" className="flex items-start gap-2 text-small text-danger-700">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      {erro}
    </p>
  );

  // Sem escolha: só os dois botões (nenhum campo na tela) e uma frase que ajuda a decidir.
  if (via === null) {
    return (
      <div className="space-y-4">
        <div role="group" aria-label="Como você quer se registrar" className="space-y-3">
          {comSenha && (
            <Button ref={primeiraEscolha} type="button" variant="outline" className="w-full" onClick={() => setVia("senha")}>
              <Mail className="h-4 w-4" />
              {NOME_DA_VIA.senha}
            </Button>
          )}
          {google && (
            <Button
              // Sem o botão de e-mail na tela, este é o primeiro botão de escolha.
              ref={comSenha ? undefined : primeiraEscolha}
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setVia("google")}
            >
              <GoogleIcon className="h-4 w-4" />
              {NOME_DA_VIA.google}
            </Button>
          )}
        </div>
        <p className="text-caption text-ink-3">
          Com e-mail, você cria uma senha e confirma pelo link que enviamos. Com o Google, o seu e-mail é confirmado na hora.
        </p>
        {mensagemDeErro}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-small text-ink-2">
        <span>{NOME_DA_VIA[via]}</span>
        {unica === null && (
          <button
            type="button"
            onClick={() => {
              voltouPorTrocar.current = true;
              setVia(null);
            }}
            className="rounded-sm text-foreground underline-offset-4 hover:underline"
          >
            Trocar
          </button>
        )}
      </div>

      <form action={acao} className="space-y-4">
        {/* Os campos da empresa servem às duas opções e ficam sempre no mesmo lugar. */}
        <div className="space-y-1">
          <Label htmlFor="empresa">Nome da empresa</Label>
          <Input
            id="empresa"
            name="empresa"
            required
            minLength={2}
            maxLength={120}
            autoFocus
            placeholder="Fazenda Boa Vista"
            {...ligar("empresa")}
            aria-invalid={invalido("empresa")}
            className={erroCls}
          />
        </div>
        <div className="grid grid-cols-[1fr_72px] gap-3">
          <div className="space-y-1">
            <Label htmlFor="cidade">Cidade (opcional)</Label>
            <Input
              id="cidade"
              name="cidade"
              maxLength={80}
              placeholder="Sorriso"
              {...ligar("cidade")}
              aria-invalid={invalido("cidade")}
              className={erroCls}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="estado">UF</Label>
            <Input
              id="estado"
              name="estado"
              maxLength={2}
              placeholder="MT"
              {...ligar("estado")}
              aria-invalid={invalido("estado")}
              className={`uppercase ${erroCls}`}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cnpj">CNPJ (opcional)</Label>
          <Input
            id="cnpj"
            name="cnpj"
            inputMode="numeric"
            maxLength={18}
            placeholder="00.000.000/0000-00"
            {...ligar("cnpj")}
            aria-invalid={invalido("cnpj")}
            className={erroCls}
          />
        </div>

        {via === "senha" && (
          <>
            <div className="space-y-1">
              <Label htmlFor="nome">Seu nome</Label>
              <Input
                id="nome"
                name="nome"
                required
                autoComplete="name"
                maxLength={120}
                placeholder="Nome e sobrenome"
                {...ligar("nome")}
                aria-invalid={invalido("nome")}
                className={erroCls}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                maxLength={254}
                placeholder="voce@empresa.com.br"
                {...ligar("email")}
                aria-invalid={invalido("email")}
                className={erroCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  name="senha"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  aria-describedby="senha-regra"
                  aria-invalid={invalido("senha")}
                  className={erroCls}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="confirmar">Repita a senha</Label>
                <Input
                  id="confirmar"
                  name="confirmar"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  aria-invalid={invalido("confirmar")}
                  className={erroCls}
                />
              </div>
            </div>
            <p id="senha-regra" className="text-caption text-ink-3">
              Ao menos 8 caracteres. Não use o seu nome, o seu e-mail nem sequências como 12345678.
            </p>
          </>
        )}

        {mensagemDeErro}

        {/* Um único botão de enviar (leva a opção em `via`): o Enter usa sempre o certo. */}
        {via === "senha" ? (
          <div className="space-y-2">
            <Button type="submit" name="via" value="senha" className="w-full" disabled={enviando}>
              <MailCheck className="h-4 w-4" />
              Criar conta e receber o link
            </Button>
            <p className="text-caption text-ink-3">Enviamos um link para o seu e-mail. A conta é ativada quando você o abrir.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button type="submit" name="via" value="google" className="w-full" disabled={enviando}>
              <GoogleIcon className="h-4 w-4" />
              Registrar com Google
            </Button>
            <p className="text-caption text-ink-3">A sua conta Google confirma o seu e-mail na hora.</p>
          </div>
        )}
      </form>
    </div>
  );
}
