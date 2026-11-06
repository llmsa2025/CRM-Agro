import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "@crmagro/config";
import {
  CONTEXTOS_CONTATO,
  anelDeChaves,
  canonicoDeContato,
  cifrarTexto,
  cifrarTextoCom,
  comCamposCifrados,
  decifrarTexto,
  decifrarTextoCom,
  impressaoDeContato,
  impressaoDeSufixo,
  impressoesDeContato,
  kidDoIndice,
  modoCifraContatos,
  sufixo8DoTelefone,
  textoPrecisaRecifrar,
} from "@crmagro/db";
import { logger } from "../logger/index";
import {
  buscaExataDeContatos,
  classificarTermoDeBusca,
  hashDeIdentificador,
  hashesDeBusca,
  hashesDeNumeros,
  ondeConversaPorNumero,
  ondeIdentificadorExato,
  ondeLidPorTelefone,
  termoPareceTelefoneOuEmailParcial,
  valorDe,
  numeroDe,
} from "./identificadores-cifra";
import { primaryTelefone, emailParaEnvio } from "./identifiers";
import { contatoParaNavegador } from "./dto";
import { IdentifierTaken } from "./errors";

/**
 * Cifra de e-mail e telefone dos contatos: as peças PURAS (sem banco): normalização, cifra, índice cego,
 * os `where` por modo, a leitura e a busca digitada. O comportamento com banco está em
 * `cifra-contatos.test.ts`.
 */
const TIME = "00000000-0000-0000-0000-00000000c0f1";
const OUTRO = "00000000-0000-0000-0000-00000000c0f2";
const CHAVE_ORIGINAL = process.env.CONTATOS_INDICE_KEY;

function modo(m: "off" | "dupla" | "indice" | "ligada") {
  process.env.CONTATOS_CIFRA = m;
}

afterEach(() => {
  process.env.CONTATOS_CIFRA = "off";
  process.env.CONTATOS_INDICE_KEY = CHAVE_ORIGINAL;
  process.env.CONTATOS_INDICE_KEY_ANTERIOR = "";
  vi.restoreAllMocks();
});

describe("flag CONTATOS_CIFRA", () => {
  it("lê a cada chamada, e ausente ou com erro de digitação é off", () => {
    modo("indice");
    expect(modoCifraContatos()).toBe("indice");
    process.env.CONTATOS_CIFRA = "";
    expect(modoCifraContatos()).toBe("off");
    process.env.CONTATOS_CIFRA = "ligado-errado";
    expect(modoCifraContatos()).toBe("off");
    delete process.env.CONTATOS_CIFRA;
    expect(modoCifraContatos()).toBe("off");
  });

  it("o schema do env aceita só os 4 modos, tem off por padrão e exige 32+ caracteres na chave do índice", () => {
    const modoCampo = envSchema.shape.CONTATOS_CIFRA;
    expect(modoCampo.parse(undefined)).toBe("off");
    expect(modoCampo.parse("")).toBe("off");
    for (const m of ["off", "dupla", "indice", "ligada"]) expect(modoCampo.parse(m)).toBe(m);
    expect(modoCampo.safeParse("ligado").success).toBe(false);
    const chave = envSchema.shape.CONTATOS_INDICE_KEY;
    expect(chave.parse(undefined)).toBeUndefined();
    expect(chave.parse("")).toBeUndefined();
    expect(chave.safeParse("curta").success).toBe(false);
    expect(chave.safeParse("x".repeat(32)).success).toBe(true);
    expect(envSchema.shape.CONTATOS_INDICE_KEY_ANTERIOR.safeParse("curta").success).toBe(false);
  });

  it("buscaExataDeContatos só vale em indice e ligada", () => {
    expect([modo("off"), buscaExataDeContatos()][1]).toBe(false);
    modo("dupla");
    expect(buscaExataDeContatos()).toBe(false);
    modo("indice");
    expect(buscaExataDeContatos()).toBe(true);
    modo("ligada");
    expect(buscaExataDeContatos()).toBe(true);
  });
});

describe("forma canônica (o que entra no índice)", () => {
  it("telefone: só E.164 estrito; e-mail: minúsculo e aparado; @lid: o código; o resto não indexa", () => {
    expect(canonicoDeContato("whatsapp", " +5566999887766 ")).toBe("+5566999887766");
    expect(canonicoDeContato("whatsapp", "5566999887766")).toBeNull();
    expect(canonicoDeContato("whatsapp", "(66) 99988-7766")).toBeNull();
    expect(canonicoDeContato("whatsapp", "+55")).toBeNull();
    expect(canonicoDeContato("whatsapp", "")).toBeNull();
    expect(canonicoDeContato("whatsapp", null)).toBeNull();
    expect(canonicoDeContato("email", "  Joao.Silva@Exemplo.COM ")).toBe("joao.silva@exemplo.com");
    // Não canonicaliza ponto nem +tag do Gmail (igual ao armazenamento de hoje).
    expect(canonicoDeContato("email", "a.b+c@gmail.com")).toBe("a.b+c@gmail.com");
    expect(canonicoDeContato("email", "sem-arroba")).toBeNull();
    expect(canonicoDeContato("email", "a b@x.com")).toBeNull();
    expect(canonicoDeContato("lid", "184469901234567@lid")).toBe("184469901234567@lid");
    expect(canonicoDeContato("lid", "+5566999887766")).toBeNull();
  });

  it("as duas variantes do 9º dígito têm o mesmo sufixo de 8 dígitos; menos de 8 dígitos não tem", () => {
    expect(sufixo8DoTelefone("+5566999887766")).toBe("99887766");
    expect(sufixo8DoTelefone("+556699887766")).toBe("99887766");
    expect(impressaoDeSufixo(TIME, "+5566999887766")).toBe(impressaoDeSufixo(TIME, "+556699887766"));
    expect(impressaoDeSufixo(TIME, "+5566999887766")).not.toBe(impressaoDeSufixo(OUTRO, "+5566999887766"));
    expect(sufixo8DoTelefone("1234567")).toBeNull();
    expect(impressaoDeSufixo(TIME, "123")).toBeNull();
  });
});

describe("índice cego (HMAC por time)", () => {
  it("é estável, no formato kid.32hex e não revela o valor", () => {
    const a = impressaoDeContato(TIME, "whatsapp", "+5566999887766");
    expect(a).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
    expect(a).toMatch(/^[0-9a-f]{4}\.[0-9a-f]{32}$/);
    expect(a.startsWith(`${kidDoIndice()}.`)).toBe(true);
    expect(a).not.toContain("5566999887766");
  });

  it("muda de um time para outro, de um rótulo para outro e de um valor para outro", () => {
    const base = impressaoDeContato(TIME, "whatsapp", "+5566999887766");
    expect(impressaoDeContato(OUTRO, "whatsapp", "+5566999887766")).not.toBe(base);
    expect(impressaoDeContato(TIME, "email", "+5566999887766")).not.toBe(base);
    expect(impressaoDeContato(TIME, "whatsapp", "+5566999887767")).not.toBe(base);
  });

  it("vetores fixos: o índice não muda sem aviso (pega troca de chave, de rótulo ou de formato)", () => {
    // Chave de teste fixa do vitest.config.ts. Se isto quebrar, o índice de TODAS as linhas gravadas mudou.
    expect(impressaoDeContato("time-vetor", "whatsapp", "+5566999887766")).toBe("01e2.f9f968764327995827810edb748d40fa");
    expect(impressaoDeContato("time-vetor", "whatsapp", "+556699887766")).toBe("01e2.032e7b10cf93d66ab3023b8b916606f2");
    expect(impressaoDeContato("time-vetor", "email", "joao@exemplo.com")).toBe("01e2.36fe5c5075bb1328e454042f21353988");
    expect(impressaoDeContato("time-vetor", "lid", "184469901234567@lid")).toBe("01e2.f4b5277544c14a491b995b641f205afc");
    expect(impressaoDeContato("time-vetor", "sfx8", "99887766")).toBe("01e2.d968b8674307cbfa83685d8256f77508");
  });

  it("sem a chave do índice (ou curta) a escrita e a busca recusam, em vez de gravar sem índice", () => {
    delete process.env.CONTATOS_INDICE_KEY;
    expect(() => impressaoDeContato(TIME, "email", "a@b.co")).toThrow(/CONTATOS_INDICE_KEY/);
    process.env.CONTATOS_INDICE_KEY = "curta";
    expect(() => impressoesDeContato(TIME, "email", "a@b.co")).toThrow(/CONTATOS_INDICE_KEY/);
  });

  it("rotação: busca com a chave nova e a anterior; a escrita usa só a nova", () => {
    const antiga = process.env.CONTATOS_INDICE_KEY!;
    const comAntiga = impressaoDeContato(TIME, "email", "a@b.co");
    process.env.CONTATOS_INDICE_KEY = "chave-nova-do-indice-com-mais-de-32-caracteres";
    process.env.CONTATOS_INDICE_KEY_ANTERIOR = antiga;
    const novas = impressoesDeContato(TIME, "email", "a@b.co");
    expect(novas).toHaveLength(2);
    expect(novas).toContain(comAntiga);
    expect(impressaoDeContato(TIME, "email", "a@b.co")).toBe(novas[0]);
    expect(novas[0]).not.toBe(comAntiga);
    // chave anterior igual à atual não duplica
    process.env.CONTATOS_INDICE_KEY_ANTERIOR = process.env.CONTATOS_INDICE_KEY;
    expect(impressoesDeContato(TIME, "email", "a@b.co")).toHaveLength(1);
  });
});

describe("cifra AES-256-GCM presa à coluna", () => {
  it("round-trip; IV aleatório (o mesmo valor cifrado duas vezes difere); não contém o valor", () => {
    const a = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    const b = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    expect(a).not.toBe(b);
    expect(a.startsWith("crmagro.enc.v2.")).toBe(true);
    expect(a).not.toContain("5566999887766");
    expect(decifrarTexto(a, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("+5566999887766");
  });

  it("o cifrado de uma coluna não abre como outra; adulterado não abre", () => {
    const a = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    expect(() => decifrarTexto(a, CONTEXTOS_CONTATO.callPhoneNumber)).toThrow();
    const partes = a.split(".");
    partes[partes.length - 1] = partes[partes.length - 1]!.slice(0, -2) + (partes[partes.length - 1]!.endsWith("AA") ? "BB" : "AA");
    expect(() => decifrarTexto(partes.join("."), CONTEXTOS_CONTATO.channelIdentifierValor)).toThrow();
  });

  it("rotação da chave AES pelo anel: o que foi cifrado com a antiga abre com o anel novo e é marcado para recifrar", () => {
    const SEGREDO_ANTIGO = "chave-antiga-das-credenciais-com-32-caracteres!!";
    const SEGREDO_NOVO = "chave-nova-das-credenciais-com-32-caracteres!!!!";
    const antiga = anelDeChaves(SEGREDO_ANTIGO);
    // CREDENTIALS_ENCRYPTION_KEY continua sendo a antiga e a lista põe a nova na frente (a 1ª cifra)
    const nova = anelDeChaves(SEGREDO_ANTIGO, `${SEGREDO_NOVO},${SEGREDO_ANTIGO}`);
    const cifrado = cifrarTextoCom(antiga, "+5566999887766", CONTEXTOS_CONTATO.conversationExternalNumber);
    expect(decifrarTextoCom(nova, cifrado, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5566999887766");
    expect(textoPrecisaRecifrar(nova, cifrado)).toBe(true);
    const recifrado = cifrarTextoCom(nova, decifrarTextoCom(nova, cifrado, CONTEXTOS_CONTATO.conversationExternalNumber), CONTEXTOS_CONTATO.conversationExternalNumber);
    expect(textoPrecisaRecifrar(nova, recifrado)).toBe(false);
    expect(decifrarTextoCom(nova, recifrado, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5566999887766");
    // sem a chave antiga no anel, não abre (e o erro diz qual chave falta, sem o valor)
    expect(() => decifrarTextoCom(anelDeChaves(SEGREDO_NOVO), cifrado, CONTEXTOS_CONTATO.conversationExternalNumber)).toThrow(/chave/i);
  });
});

describe("comCamposCifrados (o que a escrita grava)", () => {
  it("com off devolve o dado como veio (nada muda)", () => {
    modo("off");
    const d = { canal: "whatsapp", valor: "+5566999887766" };
    expect(comCamposCifrados("channelIdentifier", TIME, d)).toBe(d);
  });

  it("identificador de telefone: cifrado + índice + sufixo; e-mail: cifrado + índice; handle: intocado", () => {
    modo("dupla");
    const tel = comCamposCifrados("channelIdentifier", TIME, { canal: "whatsapp", valor: "+5566999887766" });
    expect(tel.valor).toBe("+5566999887766");
    expect(decifrarTexto(tel.valorCifrado as string, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("+5566999887766");
    expect(tel.valorHash).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
    expect(tel.valorSufixoHash).toBe(impressaoDeSufixo(TIME, "+5566999887766"));

    const mail = comCamposCifrados("channelIdentifier", TIME, { canal: "email", valor: "Joao@Exemplo.com" });
    expect(mail.valor).toBe("Joao@Exemplo.com"); // o texto fica como veio
    expect(decifrarTexto(mail.valorCifrado as string, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("Joao@Exemplo.com");
    expect(mail.valorHash).toBe(impressaoDeContato(TIME, "email", "joao@exemplo.com"));
    expect(mail.valorSufixoHash).toBeNull();

    const ig = { canal: "instagram", valor: "joao.agro" };
    expect(comCamposCifrados("channelIdentifier", TIME, ig)).toBe(ig);
  });

  it("valor inválido: cifra o texto, não indexa", () => {
    modo("dupla");
    const lixo = comCamposCifrados("channelIdentifier", TIME, { canal: "whatsapp", valor: "abc" });
    expect(lixo.valorCifrado).toBeTruthy();
    expect(lixo.valorHash).toBeNull();
    expect(lixo.valorSufixoHash).toBeNull();
    const semArroba = comCamposCifrados("channelIdentifier", TIME, { canal: "email", valor: "sem-arroba" });
    expect(semArroba.valorHash).toBeNull();
  });

  it("update sem o canal zera os derivados (nunca fica o índice de um valor antigo); com o canal recalcula", () => {
    modo("dupla");
    const zerado = comCamposCifrados("channelIdentifier", TIME, { valor: "+5566999887766" });
    expect(zerado).toMatchObject({ valorCifrado: null, valorHash: null, valorSufixoHash: null });
    const comCanal = comCamposCifrados("channelIdentifier", TIME, { valor: "+5566999887766" }, { canal: "whatsapp" });
    expect(comCanal.valorHash).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
    const set = comCamposCifrados("channelIdentifier", TIME, { canal: "whatsapp", valor: { set: "+5566999887766" } });
    expect(set.valorHash).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
  });

  it("campo ausente não mexe; dado já preparado por quem chamou não é refeito", () => {
    modo("dupla");
    const so = { isPrimary: true };
    expect(comCamposCifrados("channelIdentifier", TIME, so)).toBe(so);
    const pronto = { canal: "whatsapp", valor: "+5566999887766", valorCifrado: "x", valorHash: "y", valorSufixoHash: null };
    expect(comCamposCifrados("channelIdentifier", TIME, pronto)).toBe(pronto);
  });

  it("conversa: telefone vai cifrado e indexado; @lid fica em claro só com índice; null zera", () => {
    modo("dupla");
    const tel = comCamposCifrados("conversation", TIME, { externalNumber: "+5566999887766" });
    expect(decifrarTexto(tel.externalNumberCifrado as string, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5566999887766");
    expect(tel.externalNumberHash).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
    const lid = comCamposCifrados("conversation", TIME, { externalNumber: "184469901234567@lid" });
    expect(lid.externalNumberCifrado).toBeNull();
    expect(lid.externalNumberHash).toBe(impressaoDeContato(TIME, "lid", "184469901234567@lid"));
    expect(comCamposCifrados("conversation", TIME, { externalNumber: null })).toMatchObject({ externalNumberCifrado: null, externalNumberHash: null });
    const outro = { externalName: "Fulano" };
    expect(comCamposCifrados("conversation", TIME, outro)).toBe(outro);
  });

  it("par @lid, ligação e destinatário de campanha", () => {
    modo("dupla");
    const par = comCamposCifrados("whatsAppLid", TIME, { telefone: "+5566999887766" });
    expect(par.telefoneHash).toBe(impressaoDeContato(TIME, "whatsapp", "+5566999887766"));
    expect(decifrarTexto(par.telefoneCifrado as string, CONTEXTOS_CONTATO.whatsappLidTelefone)).toBe("+5566999887766");
    const lig = comCamposCifrados("call", TIME, { phoneNumber: "+5566999887766" });
    expect(decifrarTexto(lig.phoneNumberCifrado as string, CONTEXTOS_CONTATO.callPhoneNumber)).toBe("+5566999887766");
    expect("phoneNumberHash" in lig).toBe(false); // ligação não tem índice
    const rec = comCamposCifrados("campaignRecipient", TIME, { telefone: "+5566999887766" });
    expect(decifrarTexto(rec.telefoneCifrado as string, CONTEXTOS_CONTATO.campaignRecipientTelefone)).toBe("+5566999887766");
    expect(comCamposCifrados("campaignRecipient", TIME, { telefone: null })).toMatchObject({ telefoneCifrado: null });
  });
});

describe("leitura: valorDe e numeroDe", () => {
  it("off e dupla leem o texto; indice e ligada preferem o cifrado; sem texto, usa o cifrado", () => {
    const cifrado = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    const linha = { valor: "texto-diferente", valorCifrado: cifrado };
    modo("off");
    expect(valorDe(linha)).toBe("texto-diferente");
    modo("dupla");
    expect(valorDe(linha)).toBe("texto-diferente");
    modo("indice");
    expect(valorDe(linha)).toBe("+5566999887766");
    modo("ligada");
    expect(valorDe(linha)).toBe("+5566999887766");
    modo("off");
    expect(valorDe({ valor: null, valorCifrado: cifrado })).toBe("+5566999887766");
  });

  it("legado só com texto continua funcionando em todos os modos; campo vazio vira null", () => {
    for (const m of ["off", "dupla", "indice", "ligada"] as const) {
      modo(m);
      expect(valorDe({ valor: "+5566999887766" })).toBe("+5566999887766");
      expect(valorDe({ valor: null, valorCifrado: null })).toBeNull();
      expect(valorDe({})).toBeNull();
    }
  });

  it("cifrado que não abre: cai no texto (ou null) e avisa no log SEM o valor", () => {
    const erro = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    modo("ligada");
    const deOutraColuna = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.callPhoneNumber);
    expect(valorDe({ valor: "+5500000000000", valorCifrado: deOutraColuna })).toBe("+5500000000000");
    expect(valorDe({ valor: null, valorCifrado: deOutraColuna })).toBeNull();
    expect(erro).toHaveBeenCalled();
    const tudo = JSON.stringify(erro.mock.calls);
    expect(tudo).not.toContain("5566999887766");
    expect(tudo).not.toContain("5500000000000");
  });

  it("numeroDe lê *Cifrado das conversas, pares, ligações e destinatários", () => {
    modo("ligada");
    const c = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.conversationExternalNumber);
    expect(numeroDe({ externalNumber: "x", externalNumberCifrado: c }, "externalNumber", "conversation")).toBe("+5566999887766");
    const ligacao = cifrarTexto("+5511988887777", CONTEXTOS_CONTATO.callPhoneNumber);
    expect(numeroDe({ phoneNumber: "x", phoneNumberCifrado: ligacao }, "phoneNumber", "call")).toBe("+5511988887777");
    expect(numeroDe({ externalNumber: "184469901234567@lid" }, "externalNumber", "conversation")).toBe("184469901234567@lid");
  });

  it("primaryTelefone e emailParaEnvio abrem o cifrado; falha de leitura do e-mail é dita sem o valor", () => {
    modo("ligada");
    const t = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    const m = cifrarTexto("joao@exemplo.com", CONTEXTOS_CONTATO.channelIdentifierValor);
    const ids = [
      { canal: "whatsapp" as const, valor: "+5500000000000", valorCifrado: t, isPrimary: true },
      { canal: "email" as const, valor: "x@x.co", valorCifrado: m, isPrimary: true },
    ];
    expect(primaryTelefone(ids)).toBe("+5566999887766");
    expect(emailParaEnvio(ids)).toEqual({ email: "joao@exemplo.com", motivo: null });
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const quebrado = [{ canal: "email" as const, valor: null as unknown as string, valorCifrado: "crmagro.enc.v2.lixo", isPrimary: true }];
    const r = emailParaEnvio(quebrado);
    expect(r.email).toBeNull();
    expect(r.motivo).not.toContain("@");
  });
});

describe("where por modo", () => {
  const V = ["+5566999887766", "+556699887766"];

  it("off e dupla comparam o texto, exatamente como antes", () => {
    for (const m of ["off", "dupla"] as const) {
      modo(m);
      expect(ondeIdentificadorExato(TIME, "whatsapp", V)).toEqual({ canal: "whatsapp", valor: { in: V } });
      expect(ondeConversaPorNumero(TIME, V)).toEqual({ externalNumber: { in: V } });
      expect(ondeLidPorTelefone(TIME, V)).toEqual({ telefone: { in: V } });
    }
  });

  it("indice compara o índice e cai no texto só nas linhas sem índice", () => {
    modo("indice");
    const H = hashesDeBusca(TIME, "whatsapp", V);
    expect(H).toHaveLength(2);
    expect(ondeIdentificadorExato(TIME, "whatsapp", V)).toEqual({
      canal: "whatsapp",
      OR: [{ valorHash: { in: H } }, { valorHash: null, valor: { in: V } }],
    });
    expect(ondeConversaPorNumero(TIME, V)).toEqual({
      OR: [{ externalNumberHash: { in: H } }, { externalNumberHash: null, externalNumber: { in: V } }],
    });
    expect(ondeLidPorTelefone(TIME, V)).toEqual({
      OR: [{ telefoneHash: { in: H } }, { telefoneHash: null, telefone: { in: V } }],
    });
  });

  it("ligada compara só o índice, sem fallback; handle de instagram sempre pelo texto", () => {
    modo("ligada");
    const H = hashesDeBusca(TIME, "email", ["joao@exemplo.com"]);
    expect(ondeIdentificadorExato(TIME, "email", ["joao@exemplo.com"])).toEqual({ canal: "email", valorHash: { in: H } });
    expect(ondeIdentificadorExato(TIME, "instagram", ["joao.agro"])).toEqual({ canal: "instagram", valor: { in: ["joao.agro"] } });
    expect(ondeConversaPorNumero(TIME, ["184469901234567@lid"])).toEqual({
      externalNumberHash: { in: hashesDeNumeros(TIME, ["184469901234567@lid"]) },
    });
  });

  it("valor que não é canônico não entra no índice (e em ligada não casa nada)", () => {
    modo("ligada");
    expect(hashesDeBusca(TIME, "whatsapp", ["abc", ""])).toEqual([]);
    expect(hashDeIdentificador(TIME, "email", "sem-arroba")).toBeNull();
    expect(ondeIdentificadorExato(TIME, "whatsapp", ["abc"])).toEqual({ canal: "whatsapp", valorHash: { in: [] } });
  });

  it("o mesmo número em dois times tem índices diferentes", () => {
    modo("indice");
    expect(hashesDeBusca(TIME, "whatsapp", ["+5566999887766"])).not.toEqual(hashesDeBusca(OUTRO, "whatsapp", ["+5566999887766"]));
  });
});

describe("busca digitada", () => {
  it("classifica e-mail, telefone em qualquer formato, 8 ou 9 dígitos e texto", () => {
    expect(classificarTermoDeBusca("Joao@Exemplo.com")).toMatchObject({ tipo: "email", email: "joao@exemplo.com" });
    expect(classificarTermoDeBusca("(66) 99988-7766")).toMatchObject({ tipo: "telefone", telefone: "+5566999887766" });
    expect(classificarTermoDeBusca("+55 66 99988 7766")).toMatchObject({ tipo: "telefone", telefone: "+5566999887766" });
    expect(classificarTermoDeBusca("66999887766")).toMatchObject({ tipo: "telefone" });
    expect(classificarTermoDeBusca("99887766")).toMatchObject({ tipo: "sufixo8", sufixo8: "99887766" });
    expect(classificarTermoDeBusca("999887766")).toMatchObject({ tipo: "sufixo8", sufixo8: "99887766" });
    expect(classificarTermoDeBusca("12345678")).toMatchObject({ tipo: "sufixo8" });
    expect(classificarTermoDeBusca("99988")).toMatchObject({ tipo: "texto" }); // trecho
    expect(classificarTermoDeBusca("joao@")).toMatchObject({ tipo: "texto" }); // trecho de e-mail
    expect(classificarTermoDeBusca("Fazenda Boa Vista")).toMatchObject({ tipo: "texto" });
    expect(classificarTermoDeBusca("   ")).toMatchObject({ tipo: "texto" });
  });

  it("a tela avisa só quando parece telefone ou e-mail parcial, e só com a cifra em indice/ligada", () => {
    modo("off");
    expect(termoPareceTelefoneOuEmailParcial("99988")).toBe(false);
    modo("indice");
    expect(termoPareceTelefoneOuEmailParcial("99988")).toBe(true);
    expect(termoPareceTelefoneOuEmailParcial("joao@")).toBe(true);
    expect(termoPareceTelefoneOuEmailParcial("Fazenda")).toBe(false);
    expect(termoPareceTelefoneOuEmailParcial("(66) 99988-7766")).toBe(false); // completo: acha
  });
});

describe("DTO e erros sem dado pessoal", () => {
  it("contatoParaNavegador tira o CPF cifrado e os campos internos dos identificadores e deixa o valor legível", () => {
    modo("ligada");
    const cifrado = cifrarTexto("+5566999887766", CONTEXTOS_CONTATO.channelIdentifierValor);
    const out = contatoParaNavegador({
      id: "c1",
      nome: "Ana",
      cpfCifrado: "crmagro.enc.v2.x",
      cpfHash: "h",
      identifiers: [{ canal: "whatsapp", valor: "texto", valorCifrado: cifrado, valorHash: "h1", valorSufixoHash: "h2", isPrimary: true }],
    });
    expect(out).not.toHaveProperty("cpfCifrado");
    expect(out).not.toHaveProperty("cpfHash");
    expect(out.identifiers[0]).toEqual({ canal: "whatsapp", valor: "+5566999887766", isPrimary: true });
    const json = JSON.stringify(out);
    for (const proibido of ["valorCifrado", "valorHash", "valorSufixoHash", "crmagro.enc"]) expect(json).not.toContain(proibido);
  });

  it("IdentifierTaken: com off a mensagem é a de sempre; com a cifra ligada não leva o valor", () => {
    modo("off");
    const antes = new IdentifierTaken("whatsapp", "+5566999887766");
    expect(antes.message).toContain("+5566999887766");
    expect(Object.keys(antes)).toContain("valor");
    for (const m of ["dupla", "indice", "ligada"] as const) {
      modo(m);
      const e = new IdentifierTaken("email", "joao@exemplo.com");
      expect(e.message).not.toContain("joao@exemplo.com");
      expect(e.message).toContain("e-mail");
      expect(Object.keys(e)).not.toContain("valor");
      expect(JSON.stringify(e)).not.toContain("joao@exemplo.com");
      expect(e.valor).toBe("joao@exemplo.com"); // quem trata o erro ainda lê a propriedade
    }
    modo("indice");
    expect(new IdentifierTaken("instagram", "joao.agro").message).toContain("joao.agro"); // handle público
  });
});
