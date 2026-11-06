import { describe, expect, it } from "vitest";
import { comRetentativaDeDeadlock } from "./controle";

/** Erro como o Prisma devolve o aborto de deadlock do Postgres (PostgresError 40P01). */
const deadlock = () => new Error('Error occurred during query execution: PostgresError { code: "40P01", message: "deadlock detected" }');

describe("comRetentativaDeDeadlock", () => {
  it("repete a gravação que perdeu o deadlock e devolve o resultado da que passou", async () => {
    let chamadas = 0;
    const r = await comRetentativaDeDeadlock(async () => {
      chamadas++;
      if (chamadas < 3) throw deadlock();
      return { count: 7 };
    });
    expect(r).toEqual({ count: 7 });
    expect(chamadas).toBe(3);
  });

  it("desiste depois do limite de tentativas e sobe o erro de deadlock", async () => {
    let chamadas = 0;
    await expect(
      comRetentativaDeDeadlock(async () => {
        chamadas++;
        throw deadlock();
      }, 2),
    ).rejects.toThrow(/deadlock/);
    expect(chamadas).toBe(2);
  });

  it("erro que não é de deadlock sobe na primeira, sem repetir", async () => {
    let chamadas = 0;
    await expect(
      comRetentativaDeDeadlock(async () => {
        chamadas++;
        throw new Error("conexão recusada");
      }),
    ).rejects.toThrow("conexão recusada");
    expect(chamadas).toBe(1);
  });
});
