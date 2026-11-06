import { describe, expect, it } from "vitest";
import {
  FLOW_TIPOS,
  TIPOS_DISPONIVEIS,
  faltaParaAtivar,
  gatilhoServeAoTipo,
  gatilhosDoTipo,
  noServeAoTipo,
  problemasDoTipo,
} from "./tipos";

/** Todos os passos que existem hoje no motor (enum `FlowNodeType`) mais o "Postagem", que chega com o marketing. */
const TODOS_OS_NOS = [
  "send_message", "send_email", "send_social", "switch_flow", "wait", "typing", "condition", "ab_split", "update_stage", "create_deal",
  "add_tag", "notify_user", "http_request", "ai_agent", "manual_call", "sync_name", "end", "social_post",
];
const TODOS_OS_GATILHOS = ["contact_created", "stage_changed", "tag_added", "message_received", "manual", "contacts_selected", "schedule", "webhook"];

describe("tipos de fluxo: passos", () => {
  it("prospecção aceita tudo que já existia e recusa só a Postagem", () => {
    const recusados = TODOS_OS_NOS.filter((n) => !noServeAoTipo("prospeccao", n));
    expect(recusados).toEqual(["social_post"]);
  });

  it("marketing aceita só a Postagem e os passos que não dependem de contato", () => {
    const aceitos = TODOS_OS_NOS.filter((n) => noServeAoTipo("marketing", n)).sort();
    expect(aceitos).toEqual(["end", "http_request", "social_post", "wait"]);
  });

  it("nenhum passo que fala com contato entra em marketing", () => {
    for (const n of ["send_message", "send_email", "send_social", "ai_agent", "typing", "manual_call", "sync_name", "notify_user", "add_tag"]) {
      expect(noServeAoTipo("marketing", n), n).toBe(false);
    }
  });

  it("a Postagem não entra em prospecção (o motivo do tipo existir)", () => {
    expect(noServeAoTipo("prospeccao", "social_post")).toBe(false);
  });
});

describe("tipos de fluxo: gatilhos", () => {
  it("prospecção aceita todos; marketing só Manual e Agendado", () => {
    expect(gatilhosDoTipo("prospeccao", TODOS_OS_GATILHOS)).toEqual(TODOS_OS_GATILHOS);
    expect(gatilhosDoTipo("marketing", TODOS_OS_GATILHOS)).toEqual(["manual", "schedule"]);
    expect(gatilhoServeAoTipo("marketing", "message_received")).toBe(false);
  });

  it("Contatos selecionados é de contato: marketing não aceita, os outros tipos sim", () => {
    expect(gatilhoServeAoTipo("marketing", "contacts_selected")).toBe(false);
    expect(gatilhoServeAoTipo("prospeccao", "contacts_selected")).toBe(true);
    expect(gatilhoServeAoTipo("enriquecimento", "contacts_selected")).toBe(true);
  });
});

describe("problemasDoTipo", () => {
  it("fluxo de prospecção normal não tem problema", () => {
    expect(problemasDoTipo({ tipo: "prospeccao", triggerType: "tag_added", nodeTipos: ["send_message", "wait", "ai_agent"] })).toEqual([]);
  });

  it("Postagem em fluxo de prospecção: diz onde ela roda", () => {
    const p = problemasDoTipo({ tipo: "prospeccao", triggerType: "manual", nodeTipos: ["send_message", "social_post", "social_post"] });
    expect(p).toEqual(['O passo "Postagem" só roda em fluxo de Marketing. Este fluxo é de Prospecção.']);
  });

  it("mensagem e gatilho de contato em marketing: cada um com a sua frase, sem repetir o passo", () => {
    const p = problemasDoTipo({ tipo: "marketing", triggerType: "contact_created", nodeTipos: ["send_message", "send_message", "ai_agent", "social_post"] });
    expect(p).toEqual([
      'O gatilho "Contato criado" é de fluxo de prospecção. Fluxo de Marketing começa por Manual ou Agendado.',
      'O passo "Enviar mensagem" só roda em fluxo de Prospecção. Este fluxo é de Marketing.',
      'O passo "Agente IA" só roda em fluxo de Prospecção. Este fluxo é de Marketing.',
    ]);
    for (const frase of p) expect(frase).not.toMatch(/[—–]/);
  });
});

describe("faltaParaAtivar", () => {
  it("marketing sem Postagem não vai ao ar; com Postagem vai; prospecção não pede Postagem", () => {
    expect(faltaParaAtivar({ tipo: "marketing", nodeTipos: ["wait"] })).toContain("Postagem");
    expect(faltaParaAtivar({ tipo: "marketing", nodeTipos: ["social_post"] })).toBeNull();
    expect(faltaParaAtivar({ tipo: "prospeccao", nodeTipos: ["send_message"] })).toBeNull();
  });
});

describe("tipos disponíveis", () => {
  it("hoje se cria prospecção e enriquecimento; todo tipo disponível existe", () => {
    expect(TIPOS_DISPONIVEIS).toEqual(["prospeccao", "enriquecimento"]);
    for (const t of TIPOS_DISPONIVEIS) expect(FLOW_TIPOS).toContain(t);
  });
});

describe("fluxo de enriquecimento", () => {
  it("aceita todos os passos (inclusive funil e mensagem), menos a Postagem, que é só do marketing", () => {
    for (const n of ["condition", "sync_name", "save_history", "enrich_data", "add_tag", "wait", "http_request", "end", "create_deal", "update_stage", "notify_user", "send_message", "send_email", "send_social", "ai_agent", "manual_call", "switch_flow", "ab_split", "typing"]) {
      expect(noServeAoTipo("enriquecimento", n), n).toBe(true);
      expect(noServeAoTipo("enriquecimento", n), n).toBe(noServeAoTipo("prospeccao", n));
    }
    expect(noServeAoTipo("enriquecimento", "social_post")).toBe(false);
  });

  it("aceita qualquer gatilho de contato e está disponível para criar", () => {
    for (const g of ["manual", "schedule", "tag_added", "contact_created", "message_received"]) expect(gatilhoServeAoTipo("enriquecimento", g), g).toBe(true);
    expect(TIPOS_DISPONIVEIS).toContain("enriquecimento");
  });

  it("o passo de histórico também serve à prospecção, mas não ao marketing", () => {
    expect(noServeAoTipo("prospeccao", "save_history")).toBe(true);
    expect(noServeAoTipo("marketing", "save_history")).toBe(false);
  });

  it("explica o que não pode, com o nome do tipo", () => {
    const [p] = problemasDoTipo({ tipo: "enriquecimento", triggerType: "manual", nodeTipos: ["social_post"] });
    expect(p).toContain("Postagem");
    expect(p).toContain("Enriquecimento");
  });
});
