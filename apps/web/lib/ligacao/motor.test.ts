import { describe, expect, it } from "vitest";
import { CODIGOS_DO_MOTOR, codigoDoErroDoMotor, ehErroDoMotor, ErroDoMotor, MOTIVOS_LOCAIS_DO_FIM, TAMANHO_MAXIMO_DO_ANEXO } from "./motor";

describe("ErroDoMotor", () => {
  it("carrega só o código fechado: a mensagem é o próprio código, sem texto de SDK", () => {
    const e = new ErroDoMotor("microfone_negado");
    expect(e.codigo).toBe("microfone_negado");
    expect(e.message).toBe("microfone_negado");
    expect(e.name).toBe("ErroDoMotor");
    expect(Object.keys(e).sort()).toEqual(["codigo", "name"]); // nada de cause nem de texto do SDK
  });

  it("os códigos e os motivos do contrato são os fechados do plano", () => {
    expect([...CODIGOS_DO_MOTOR]).toEqual(["microfone_negado", "sem_microfone", "navegador_sem_suporte", "sem_audio", "conexao_caiu", "provedor"]);
    expect([...MOTIVOS_LOCAIS_DO_FIM]).toEqual(["desligou", "contato_desligou", "falha_de_rede", "desconhecido"]);
    expect(TAMANHO_MAXIMO_DO_ANEXO).toBe(16 * 1024);
  });

  it("reconhece o erro do motor, inclusive o de uma segunda cópia do módulo", () => {
    expect(ehErroDoMotor(new ErroDoMotor("sem_audio"))).toBe(true);
    expect(ehErroDoMotor({ name: "ErroDoMotor", codigo: "sem_audio" })).toBe(true);
    expect(ehErroDoMotor({ name: "ErroDoMotor", codigo: "texto livre do SDK" })).toBe(false);
    expect(ehErroDoMotor(new Error("sem_audio"))).toBe(false);
    expect(ehErroDoMotor(null)).toBe(false);
    expect(ehErroDoMotor("sem_audio")).toBe(false);
  });

  it("qualquer outra coisa lançada vira o código padrão, sem repassar a mensagem", () => {
    expect(codigoDoErroDoMotor(new ErroDoMotor("conexao_caiu"), "provedor")).toBe("conexao_caiu");
    expect(codigoDoErroDoMotor(new Error("Falha em +5511999990000"), "provedor")).toBe("provedor");
    expect(codigoDoErroDoMotor(undefined, "sem_audio")).toBe("sem_audio");
  });
});
