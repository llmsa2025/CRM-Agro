/**
 * N5: o roteiro de homologação, sempre contra o Nectar FALSO (nunca a conta de
 * teste de verdade), com `pausaMs: 0`. Sem banco. O `fetch` real é proibido.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { criarNectarFalso, TOKEN_FALSO_NECTAR } from "../../../../test-support/nectar-falso";
import { CrmResultadoIncerto } from "../../errors";
import { criarClienteNectar } from "./client";
import { CHECKLIST_VISUAL, permitidoRodarHomologacao, rodarHomologacao, trechoSeguro, type ArquivoDeTeste } from "./homologacao";

const fetchOriginal = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("fetch real proibido");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = fetchOriginal;
});

const TELEFONE = "+5562999998888";
const AGORA = () => new Date("2026-09-30T14:05:00Z");
const base = { token: TOKEN_FALSO_NECTAR, pausaMs: 0, agora: AGORA };

const casoDe = <T extends { id: string }>(casos: T[], id: string): T | undefined => casos.find((c) => c.id === id);

describe("permitidoRodarHomologacao", () => {
  it("recusa sem a variável e sem o token", () => {
    expect(permitidoRodarHomologacao({})).toMatchObject({ ok: false });
    expect(permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO_TOKEN: "abc" })).toMatchObject({ ok: false });
    expect(permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: "conta-de-teste" })).toMatchObject({ ok: false });
  });

  it("valor diferente de conta-de-teste também recusa (sim, true, 1, maiúscula)", () => {
    for (const valor of ["sim", "true", "1", "Conta-de-Teste", "conta-de-teste ", "producao"]) {
      const r = permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: valor, NECTAR_HOMOLOGACAO_TOKEN: "abc" });
      expect(r.ok).toBe(false);
    }
  });

  it("com conta-de-teste e o token, aceita; telefone null sem a variável", () => {
    expect(permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: "conta-de-teste", NECTAR_HOMOLOGACAO_TOKEN: "  tok  " })).toEqual({ ok: true, token: "tok", telefone: null });
    expect(permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: "conta-de-teste", NECTAR_HOMOLOGACAO_TOKEN: "tok", NECTAR_HOMOLOGACAO_TELEFONE: TELEFONE })).toEqual({
      ok: true,
      token: "tok",
      telefone: TELEFONE,
    });
  });

  it("telefone fora do E.164 recusa (o número tem de ser o do dono, sem pontuação)", () => {
    const r = permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: "conta-de-teste", NECTAR_HOMOLOGACAO_TOKEN: "tok", NECTAR_HOMOLOGACAO_TELEFONE: "(62) 99999-8888" });
    expect(r.ok).toBe(false);
  });

  it("o motivo da recusa nunca leva o token", () => {
    const r = permitidoRodarHomologacao({ NECTAR_HOMOLOGACAO: "sim", NECTAR_HOMOLOGACAO_TOKEN: "tok-SEGREDO-999" });
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });
});

describe("rodarHomologacao contra o falso", () => {
  it("todo caso tem resultado, e o relatório não leva o token, sipPassword nem o telefone", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    expect(r.casos.length).toBeGreaterThan(30);
    for (const c of r.casos) {
      expect(["ok", "falhou", "observar", "nao_testado"]).toContain(c.resultado);
      expect(c.id).toBeTruthy();
      expect(c.grupo).toBeTruthy();
      expect(c.descricao).toBeTruthy();
    }
    expect(new Set(r.casos.map((c) => c.id)).size).toBe(r.casos.length);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(TOKEN_FALSO_NECTAR);
    expect(texto).not.toContain("sipPassword\":\"");
    expect(texto).not.toContain("segredo-sip");
    for (const forma of ["+5562999998888", "5562999998888", "62999998888", "99999-8888", "999998888", "6299998888", "9999-8888"]) {
      expect(texto).not.toContain(forma);
    }
    // O relatório só diz SE o sipPassword aparece, nunca o valor.
    expect(casoDe(r.casos, "conta.usuarios-attribute")?.observado).toMatchObject({ sipPasswordSemAttribute: true, attributeLimita: true });
    expect(r.checklistVisual).toEqual([...CHECKLIST_VISUAL]);
    expect(r.checklistVisual.length).toBeGreaterThanOrEqual(7);
  });

  it("o primeiro caso chama a API, e o resultado mostra o que o falso responde", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: null, transporte: falso.transporte });
    expect(r.casos[0]).toMatchObject({ id: "conta.funis-vendas", resultado: "ok" });
    expect(casoDe(r.casos, "conta.funis-pre-venda")?.observado).toMatchObject({ temLeadboard: true });
    expect(casoDe(r.casos, "conta.usuarios-rota")?.observado).toMatchObject({ statusPlural: 200 });
    expect(casoDe(r.casos, "notas.tamanho-100k")?.observado).toMatchObject({ igual: true, cortado: false });
    expect(r.chamadas).toBe(falso.pedidos.length);
  });

  it("sem telefone: os casos de telefone ficam nao_testado e nenhum contato criado tem telefone", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: null, transporte: falso.transporte });
    expect(casoDe(r.casos, "contato.telefone-variantes")?.resultado).toBe("nao_testado");
    expect(casoDe(r.casos, "contato.mais-codificado")?.resultado).toBe("nao_testado");
    expect(falso.dados.contatos.length).toBeGreaterThan(2);
    for (const c of falso.dados.contatos) expect(c).not.toHaveProperty("telefones");
  });

  it("com telefone: só o número passado é usado, e as 7 variantes são procuradas", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    // Só o número passado, em qualquer formato (o caso do PUT troca a lista do contato A, como o pior caso da §2.3).
    const telefones = falso.dados.contatos.flatMap((c) => (Array.isArray(c.telefones) ? (c.telefones as string[]) : []));
    expect(telefones.length).toBeGreaterThanOrEqual(2);
    for (const t of telefones) expect(t.replace(/\D/g, "")).toMatch(/^(55)?62999998888$/);
    const variantes = casoDe(r.casos, "contato.telefone-variantes")?.observado as { achouPorVariante: Record<string, boolean>; algumaAchou: boolean };
    expect(Object.keys(variantes.achouPorVariante).sort()).toEqual(["55", "ddd", "e164", "parenteses", "parenteses_hifen", "sem_nono", "sem_nono_parenteses_hifen"]);
    // O falso guarda como foi digitado e busca exato: só a variante "(DD) 9XXXX-XXXX" acha o contato A.
    expect(variantes.achouPorVariante.parenteses_hifen).toBe(true);
    expect(variantes.achouPorVariante.e164).toBe(false);
    // O `+` sem codificar chega como espaço: o falso não acha o contato B.
    expect(casoDe(r.casos, "contato.mais-codificado")?.observado).toMatchObject({ achouCodificado: true, achouSemCodificar: false });
  });

  it("o PUT que substitui a lista aparece no relatório (o pior caso da §2.3)", async () => {
    const r = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: criarNectarFalso({ putSubstituiListas: true }).transporte });
    expect(casoDe(r.casos, "contato.put-listas")?.observado).toMatchObject({ emailsSubstituiu: true, emailsAcrescentou: false });
    const acrescenta = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: criarNectarFalso({ putSubstituiListas: false }).transporte });
    expect(casoDe(acrescenta.casos, "contato.put-listas")?.observado).toMatchObject({ emailsSubstituiu: false, emailsAcrescentou: true });
  });

  it("qualificação: sem Leadboard os casos ficam nao_testado; com Leadboard, o erro de Cliente, Prospect e Descartado aparece", async () => {
    const sem = await rodarHomologacao({ ...base, telefone: null, transporte: criarNectarFalso({ funisPreVenda: "403" }).transporte });
    expect(casoDe(sem.casos, "conta.funis-pre-venda")?.observado).toMatchObject({ temLeadboard: false });
    expect(casoDe(sem.casos, "qualificacao.criar-formas-do-funil")?.resultado).toBe("nao_testado");
    expect(casoDe(sem.casos, "qualificacao.listar")?.resultado).toBe("observar");
    const com = await rodarHomologacao({ ...base, telefone: null, transporte: criarNectarFalso().transporte });
    const constantes = casoDe(com.casos, "qualificacao.constantes")?.observado as Record<string, { aceitou: boolean; erro?: string }>;
    for (const k of ["constante0", "constante1", "constante5"]) expect(constantes[k]?.aceitou).toBe(false);
    // O trecho do erro vem sem dígitos.
    expect(constantes.constante0?.erro).toContain("Só é possível criar qualificações");
  });

  it("o texto de erro do Nectar entra só como trecho seguro (sem dígitos nem e-mail)", async () => {
    const falso = criarNectarFalso({
      falhas: [{ metodo: "POST", caminho: /^\/contatos\/$/, status: 400, texto: "contato +5562999998888 repetido de maria@cliente.com no id 4455" }],
    });
    const r = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    const criar = casoDe(r.casos, "contato.criar");
    expect(criar?.resultado).toBe("falhou");
    const texto = JSON.stringify(criar);
    expect(texto).not.toContain("5562999998888");
    expect(texto).not.toContain("maria@cliente.com");
    const erro = (criar?.observado as { erroA: string }).erroA;
    expect(erro).not.toMatch(/\d/);
    expect(erro).toContain("repetido de <e-mail>");
    // Os casos que dependem do contato ficam nao_testado (com o motivo), sem quebrar a rodada.
    expect(casoDe(r.casos, "contato.codigo")?.resultado).toBe("nao_testado");
  });

  it("trechoSeguro: dígitos viram #, e-mail some e o corte é de 200 caracteres", () => {
    expect(trechoSeguro("id 123 de a@b.com")).toBe("id ### de <e-mail>");
    expect(trechoSeguro("x".repeat(500))).toHaveLength(200);
    expect(trechoSeguro("  várias   linhas\n aqui ")).toBe("várias linhas aqui");
  });

  it("os registros criados têm o prefixo CRMAGRO TESTE HOMOLOGACAO, e todo e-mail é @example.com", async () => {
    const falso = criarNectarFalso();
    await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    const prefixo = "CRMAGRO TESTE HOMOLOGACAO 20260930-1405";
    for (const c of falso.dados.contatos) expect(String(c.nome)).toContain(prefixo);
    for (const o of falso.dados.oportunidades) expect(String(o.nome).startsWith(prefixo)).toBe(true);
    for (const q of falso.dados.qualificacoes) expect(String(q.nome).startsWith(prefixo)).toBe(true);
    for (const n of falso.dados.publicacoes) expect(String(n.assunto ?? n.descricao)).toContain(prefixo);
    const emails = falso.dados.contatos.flatMap((c) => (Array.isArray(c.emails) ? (c.emails as string[]) : []));
    expect(emails.length).toBeGreaterThan(3);
    for (const e of emails) expect(e).toMatch(/^homologacao\+\d+@example\.com$/);
    // O relatório também só fala de e-mails de @example.com (se falar).
    const relatorio = JSON.stringify(falso.dados.contatos);
    for (const m of relatorio.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) expect(m[0]).toMatch(/@example\.com$/);
  });

  it("nada é apagado no Nectar: só GET, POST e PUT", async () => {
    const falso = criarNectarFalso();
    await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    const metodos = new Set(falso.pedidos.map((p) => p.metodo));
    expect([...metodos].sort()).toEqual(["GET", "POST", "PUT"]);
  });

  it("o teto de chamadas para a rodada e marca o resto como nao_testado", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: null, transporte: falso.transporte, tetoChamadas: 10 });
    expect(r.chamadas).toBe(10);
    expect(falso.pedidos).toHaveLength(10);
    const naoTestados = r.casos.filter((c) => c.resultado === "nao_testado");
    expect(naoTestados.length).toBeGreaterThan(20);
    expect(r.casos.at(-1)?.resultado).toBe("nao_testado");
    expect(r.casos.some((c) => c.resultado === "ok" || c.resultado === "observar")).toBe(true);
    expect(JSON.stringify(naoTestados.at(-1)?.observado)).toContain("teto de 10 chamadas");
  });

  it("401 aborta: o primeiro caso falha e o resto fica nao_testado, com uma única chamada", async () => {
    const falso = criarNectarFalso({ token: "outro-token-que-o-falso-aceita" });
    const r = await rodarHomologacao({ ...base, telefone: TELEFONE, transporte: falso.transporte });
    expect(r.casos[0]).toMatchObject({ resultado: "falhou", observado: { status: 401 } });
    expect(r.casos.slice(1).every((c) => c.resultado === "nao_testado")).toBe(true);
    expect(r.chamadas).toBe(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN_FALSO_NECTAR);
  });

  it("respeita a pausa entre as chamadas", async () => {
    const falso = criarNectarFalso();
    const inicio = Date.now();
    await rodarHomologacao({ ...base, pausaMs: 25, telefone: null, transporte: falso.transporte, tetoChamadas: 5 });
    // 5 chamadas: 4 pausas de 25 ms.
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(95);
  });

  it("o cabeçalho X-No-Webhook vai só na chamada que testa esse cabeçalho", async () => {
    const falso = criarNectarFalso();
    await rodarHomologacao({ ...base, telefone: null, transporte: falso.transporte });
    const comCabecalho = falso.pedidos.filter((p) => "X-No-Webhook" in p.cabecalhos);
    expect(comCabecalho).toHaveLength(1);
    expect(comCabecalho[0]!.metodo).toBe("POST");
    expect(comCabecalho[0]!.url).toContain("/publicacao/");
  });

  it("o JWT: só as chaves e se tem exp (nunca o token nem o payload inteiro)", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "HS256" })}.${b64({ usuarioMasterId: 42, exp: 1_893_456_000, email: "alguem@cliente.com" })}.assinatura`;
    const falso = criarNectarFalso({ token: jwt });
    const r = await rodarHomologacao({ ...base, token: jwt, telefone: null, transporte: falso.transporte, tetoChamadas: 3 });
    const caso = casoDe(r.casos, "conta.jwt");
    expect(caso?.observado).toMatchObject({ ehJwt: true, chavesDoPayload: ["email", "exp", "usuarioMasterId"], temUsuarioMasterId: true, temExp: true });
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(jwt);
    expect(texto).not.toContain("alguem@cliente.com");
    expect(texto).not.toContain("assinatura");
    // Sem ser JWT (o token do falso não é): só diz que não é.
    const outro = await rodarHomologacao({ ...base, telefone: null, transporte: criarNectarFalso().transporte, tetoChamadas: 3 });
    expect(casoDe(outro.casos, "conta.jwt")?.observado).toEqual({ ehJwt: false });
  });
});

describe("arquivos (multipart)", () => {
  const blob = (bytes: number) => new Blob([new Uint8Array(bytes)]);
  const arquivos = (): ArquivoDeTeste[] => [
    { nome: "teste.pdf", tipo: "application/pdf", blob: blob(1024 * 1024) },
    { nome: "teste.png", tipo: "image/png", blob: blob(2048) },
    { nome: "teste.ogg", tipo: "audio/ogg", blob: blob(4096) },
  ];

  it("sem arquivos, os casos de arquivo ficam nao_testado", async () => {
    const r = await rodarHomologacao({ ...base, telefone: null, transporte: criarNectarFalso().transporte });
    for (const id of ["arquivos.tipos", "arquivos.tamanhos", "arquivos.varios", "arquivos.extensao-proibida"]) expect(casoDe(r.casos, id)?.resultado).toBe("nao_testado");
  });

  it("com arquivos: cada tipo, os tamanhos, vários numa chamada e o .exe com o PDF; o falso guarda nome e tamanho", async () => {
    const falso = criarNectarFalso();
    const r = await rodarHomologacao({ ...base, telefone: null, transporte: falso.transporte, arquivos: arquivos() });
    expect(casoDe(r.casos, "arquivos.tipos")?.resultado).toBe("observar");
    expect(casoDe(r.casos, "arquivos.tamanhos")?.observado).toMatchObject({ "5MB": { aceito: true }, "80MB": { aceito: true } });
    expect(casoDe(r.casos, "arquivos.varios")?.observado).toMatchObject({ enviados: 3, anexosNaResposta: 3 });
    expect(casoDe(r.casos, "arquivos.extensao-proibida")?.observado).toMatchObject({ aceito: true, anexosNaResposta: 2 });
    const notasComAnexo = falso.dados.publicacoes.filter((n) => Array.isArray(n.anexos));
    expect(notasComAnexo.length).toBeGreaterThanOrEqual(6);
    const exe = notasComAnexo.flatMap((n) => n.anexos as { nome: string; tamanho: number }[]).find((a) => a.nome === "teste.exe");
    expect(exe?.tamanho).toBe(1024);
    const grande = notasComAnexo.flatMap((n) => n.anexos as { nome: string; tamanho: number }[]).find((a) => a.nome.startsWith("teste-80mb"));
    expect(grande?.tamanho).toBe(80 * 1024 * 1024);
    // Só o nome do arquivo de teste (feito pela equipe) vai para o relatório.
    expect(JSON.stringify(r)).not.toContain(TOKEN_FALSO_NECTAR);
  });
});

describe("postMultipart no cliente", () => {
  it("o pedido leva um FormData, sem Content-Type manual, com o timeout de 120 s", async () => {
    const falso = criarNectarFalso();
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    const form = new FormData();
    form.append("publicacao", JSON.stringify({ assunto: "a", descricao: "b", contato: { id: 1 } }));
    form.append("anexos", new Blob(["oi"]), "oi.txt");
    await cliente.postMultipart("/publicacao/incluirComAnexos", form, z.unknown());
    const pedido = falso.pedidos[0]!;
    expect(pedido.corpo).toBeInstanceOf(FormData);
    expect(Object.keys(pedido.cabecalhos).map((k) => k.toLowerCase())).not.toContain("content-type");
    expect(pedido.cabecalhos["Access-Token"]).toBe(TOKEN_FALSO_NECTAR);
    expect(pedido.timeoutMs).toBe(120_000);
    expect(pedido.metodo).toBe("POST");
  });

  it("500 (e tempo esgotado) depois do POST vira CrmResultadoIncerto", async () => {
    const form = () => {
      const f = new FormData();
      f.append("publicacao", "{}");
      return f;
    };
    const com500 = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: criarNectarFalso({ falhas: [{ caminho: /incluirComAnexos/, status: 500 }] }).transporte });
    await expect(com500.postMultipart("/publicacao/incluirComAnexos", form(), z.unknown())).rejects.toBeInstanceOf(CrmResultadoIncerto);
    const comTempo = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: criarNectarFalso({ tempoEsgotado: [/incluirComAnexos/] }).transporte });
    await expect(comTempo.postMultipart("/publicacao/incluirComAnexos", form(), z.unknown())).rejects.toBeInstanceOf(CrmResultadoIncerto);
  });
});
