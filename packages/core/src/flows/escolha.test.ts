import { describe, expect, it } from "vitest";
import { escolhaDaCondicao, escolhaDoSorteio, lerEscolha, textoDaEscolha } from "./escolha";

/** Puro, sem banco: o texto que o log do fluxo mostra para a saída que a condição seguiu. */
describe("escolha de um passo de decisão", () => {
  const tem = { label: "Já tem histórico (WhatsApp)" };

  it("condição com uma saída só lê-se como sim ou não", () => {
    expect(textoDaEscolha(escolhaDaCondicao([tem], 0)).curto).toBe("Já tem histórico (WhatsApp): sim");
    const nao = textoDaEscolha(escolhaDaCondicao([tem], null));
    expect(nao.curto).toBe("Já tem histórico (WhatsApp): não");
    expect(nao.longo).toBe('A saída "Já tem histórico (WhatsApp)" não casou, então seguiu pelo "senão".');
  });

  it("com várias saídas mostra a que casou, ou o senão com o que foi testado", () => {
    const ramos = [{ label: "Sem interesse" }, { label: "Tenho interesse" }, { label: "Outra resposta" }];
    expect(textoDaEscolha(escolhaDaCondicao(ramos, 1))).toEqual({ curto: "Tenho interesse", longo: 'Casou a saída "Tenho interesse".' });
    expect(textoDaEscolha(escolhaDaCondicao(ramos, null))).toEqual({
      curto: "senão",
      longo: 'Nenhuma saída casou (Sem interesse, Tenho interesse, Outra resposta), então seguiu pelo "senão".',
    });
  });

  it("rótulo em branco não vira texto vazio", () => {
    expect(escolhaDaCondicao([{ label: "  " }, { label: "B" }], 0).saida).toBe("saída 1");
    expect(escolhaDoSorteio("", 1).saida).toBe("variante 2");
  });

  it("teste A/B mostra a variante sorteada", () => {
    expect(textoDaEscolha(escolhaDoSorteio("Mensagem curta", 0))).toEqual({ curto: "Mensagem curta", longo: 'Sorteou "Mensagem curta".' });
  });

  it("lê do result gravado e ignora o que não tem o formato", () => {
    const e = escolhaDaCondicao([tem], null);
    expect(lerEscolha({ nextNodeId: "X", escolha: e })).toEqual(e);
    expect(lerEscolha({ nextNodeId: "X" })).toBeNull();
    expect(lerEscolha({ escolha: { saida: 1 } })).toBeNull();
    expect(lerEscolha(null)).toBeNull();
  });
});
