import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guarda do escopo por dono (F3, revisão do #151): todo contato criado pelo
 * core precisa gravar `ownerId`. Contato sem dono some da lista de quem o
 * cadastrou (membro vê só o que é dele) e, depois do backfill, fica sem dono
 * para sempre. Este teste lê o código e falha se algum `contact.create` /
 * `contact.createMany` não passar `ownerId` (nem que seja `null` explícito).
 */
const RAIZ = join(__dirname, "..");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return arquivos(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("test-support") ? [p] : [];
  });
}

/** Texto da chamada a partir do "(" até o ")" que fecha (conta parênteses). */
function argumentos(fonte: string, abre: number): string {
  let nivel = 0;
  for (let i = abre; i < fonte.length; i++) {
    if (fonte[i] === "(") nivel++;
    else if (fonte[i] === ")" && --nivel === 0) return fonte.slice(abre, i + 1);
  }
  return fonte.slice(abre);
}

describe("guarda: contato novo sempre com dono", () => {
  it("todo contact.create/createMany do core passa ownerId", () => {
    const semDono: string[] = [];
    let achados = 0;
    for (const arq of arquivos(RAIZ)) {
      const fonte = readFileSync(arq, "utf8");
      for (const m of fonte.matchAll(/\.contact\.create(?:Many)?\(/g)) {
        achados++;
        const args = argumentos(fonte, m.index! + m[0].length - 1);
        if (!/\bownerId\b/.test(args)) {
          const linha = fonte.slice(0, m.index).split("\n").length;
          semDono.push(`${relative(RAIZ, arq)}:${linha}`);
        }
      }
    }
    expect(achados).toBeGreaterThan(0); // o regex ainda acha as criações
    expect(semDono).toEqual([]);
  });
});
