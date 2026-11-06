import { describe, expect, it } from "vitest";
import { ehErroDoMotor } from "./motor";
import { carregarMotor, chavesDeMotor } from "./registro";

async function codigoDaFalha(promessa: Promise<unknown>): Promise<string | null> {
  try {
    await promessa;
    return null;
  } catch (e) {
    return ehErroDoMotor(e) ? e.codigo : "outro erro";
  }
}

describe("registro de motores", () => {
  it("com modoFake, a chave fake carrega o motor Fake", async () => {
    const motor = await carregarMotor("fake", { modoFake: true });
    expect(motor.chave).toBe("fake");
    expect(motor.capacidades.mudo).toBe(true);
    motor.liberar();
  });

  it("sem modoFake, o registro não tem o Fake", async () => {
    expect(chavesDeMotor({ modoFake: false })).not.toContain("fake");
    expect(chavesDeMotor({ modoFake: true })).toContain("fake");
    expect(await codigoDaFalha(carregarMotor("fake", { modoFake: false }))).toBe("navegador_sem_suporte");
  });

  it("chave desconhecida vira navegador_sem_suporte, inclusive nomes do protótipo do objeto", async () => {
    for (const chave of ["provedor_que_nao_existe", "", "FAKE", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(await codigoDaFalha(carregarMotor(chave, { modoFake: true }))).toBe("navegador_sem_suporte");
    }
  });

  it("cada carga devolve um motor novo (a ligação nunca divide motor com outra)", async () => {
    const a = await carregarMotor("fake", { modoFake: true });
    const b = await carregarMotor("fake", { modoFake: true });
    expect(a).not.toBe(b);
    a.liberar();
    b.liberar();
  });
});
