"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertCircle, Loader2, Pause, Play } from "lucide-react";
import {
  CHAVE_VELOCIDADE_AUDIO,
  deveAdotarNovaUrl,
  duracaoConhecida,
  falhaDoMediaError,
  falhaDoPlay,
  fmtDur,
  formatoTocavel,
  mensagemDaFalha,
  percentual,
  proximaVelocidade,
  rotuloDuracao,
  rotuloVelocidade,
  velocidadeSalva,
  type FalhaAudio,
  type VelocidadeAudio,
} from "@/lib/audio-player";

/**
 * Player de áudio (voz do WhatsApp): botão redondo + barra que dá pra arrastar +
 * tempo atual à esquerda e total à direita, embaixo da barra.
 *
 * Diferenças para o `<audio controls>` nativo (que ainda fica em branco quando
 * falha, sem dizer por quê):
 * - falha de carregamento/reprodução vira uma frase + "Tentar de novo" + link
 *   pra abrir o arquivo (antes o play não fazia nada e o motivo sumia);
 * - a URL assinada renovada pelo servidor NÃO reinicia o áudio que está tocando
 *   (ver `deveAdotarNovaUrl`);
 * - o tempo nunca passa por cima do botão: coluna com `min-w-0`, rótulos sem
 *   quebra de linha e largura própria.
 */
export function AudioPlayer({ src, mime }: { src: string; mime?: string | null }) {
  // O áudio NÃO fica no DOM (ver o efeito de criação): é um `Audio` solto.
  const ref = useRef<HTMLAudioElement | null>(null);
  // A URL em uso pode ficar um pouco atrás da que chega por prop (ver o efeito abaixo).
  const [srcAtivo, setSrcAtivo] = useState(src);
  const [tocando, setTocando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [falha, setFalha] = useState<FalhaAudio | null>(null);
  const [velocidade, setVelocidade] = useState<VelocidadeAudio>(1);
  // Enquanto descobre a duração (pulo pro fim e volta) o tempo/posição não devem piscar.
  const descobrindoDuracao = useRef(false);

  const formatoOk = useCallback(
    () => formatoTocavel(mime, (tipo) => ref.current?.canPlayType(tipo) ?? "maybe"),
    [mime],
  );

  const atualizarDuracao = useCallback(() => {
    const a = ref.current;
    if (!a) return;
    if (duracaoConhecida(a.duration)) {
      setDur(a.duration);
      return;
    }
    // O Chrome dá duration=Infinity quando o servidor não aceita Range (e em webm
    // gravado no navegador): pula pro fim e volta pro início pra descobrir o tamanho.
    if (a.duration === Infinity && !descobrindoDuracao.current) {
      descobrindoDuracao.current = true;
      const concluir = () => {
        a.removeEventListener("timeupdate", concluir);
        a.currentTime = 0;
        descobrindoDuracao.current = false;
        setCur(0);
        if (duracaoConhecida(a.duration)) setDur(a.duration);
      };
      a.addEventListener("timeupdate", concluir);
      a.currentTime = 1e101;
    }
  }, []);

  // Último `formatoOk` e `velocidade` para os ouvintes do efeito de criação (que não se refaz a cada render).
  const formatoOkRef = useRef(formatoOk);
  formatoOkRef.current = formatoOk;
  const velocidadeRef = useRef(velocidade);
  velocidadeRef.current = velocidade;

  // Cria o `Audio` UMA vez, FORA do DOM. Um `<audio>` na página (mesmo escondido) é achado por extensões do
  // navegador que põem um botão de velocidade sobre toda mídia ("1.00" flutuando por cima das telas, como
  // por cima do cadastro de contato). Fora do DOM nenhuma extensão enxerga, e o player continua igual.
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    a.defaultPlaybackRate = velocidadeRef.current;
    a.playbackRate = velocidadeRef.current;
    ref.current = a;

    const ouvintes: [string, () => void][] = [
      ["loadedmetadata", atualizarDuracao],
      ["durationchange", atualizarDuracao],
      ["play", () => setTocando(true)],
      ["playing", () => setCarregando(false)],
      [
        "waiting",
        () => {
          // Só é "carregando" se o usuário mandou tocar (parado no início não conta).
          if (!a.paused) setCarregando(true);
        },
      ],
      [
        "pause",
        () => {
          setTocando(false);
          setCarregando(false);
        },
      ],
      [
        "timeupdate",
        () => {
          if (!descobrindoDuracao.current) setCur(a.currentTime);
        },
      ],
      [
        "ended",
        () => {
          setTocando(false);
          setCarregando(false);
          setCur(0);
        },
      ],
      [
        "error",
        () => {
          setTocando(false);
          setCarregando(false);
          setFalha(falhaDoMediaError(a.error?.code, formatoOkRef.current()));
        },
      ],
    ];
    for (const [nome, fn] of ouvintes) a.addEventListener(nome, fn);

    return () => {
      for (const [nome, fn] of ouvintes) a.removeEventListener(nome, fn);
      a.pause();
      a.removeAttribute("src");
      a.load(); // solta a conexão do arquivo
      ref.current = null;
    };
  }, [atualizarDuracao]);

  // Fonte em uso → elemento. Só mexe se mudou (atribuir o mesmo `src` recarregaria o arquivo).
  useEffect(() => {
    const a = ref.current;
    if (a && a.getAttribute("src") !== srcAtivo) a.src = srcAtivo;
  }, [srcAtivo]);

  // Velocidade guardada da última vez (vale para todos os áudios); sem storage, fica 1x.
  useEffect(() => {
    try {
      setVelocidade(velocidadeSalva(window.localStorage.getItem(CHAVE_VELOCIDADE_AUDIO)));
    } catch {
      /* storage bloqueado: segue no normal */
    }
  }, []);

  // Aplica no elemento. `defaultPlaybackRate` faz a velocidade sobreviver à troca de fonte.
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.defaultPlaybackRate = velocidade;
    a.playbackRate = velocidade;
  }, [velocidade, srcAtivo]);

  function trocarVelocidade() {
    const v = proximaVelocidade(velocidade);
    setVelocidade(v);
    try {
      window.localStorage.setItem(CHAVE_VELOCIDADE_AUDIO, String(v));
    } catch {
      /* storage bloqueado: vale só nesta tela */
    }
  }

  // Fonte trocada de verdade → zera o estado (o navegador já recarrega sozinho).
  useEffect(() => {
    setTocando(false);
    setCarregando(false);
    setCur(0);
    setDur(0);
    setFalha(null);
    descobrindoDuracao.current = false;
  }, [srcAtivo]);

  // URL nova vinda do servidor: só troca se não interromper nada.
  useEffect(() => {
    if (deveAdotarNovaUrl({ atual: srcAtivo, nova: src, tocando, posicao: cur, comFalha: falha !== null })) {
      setSrcAtivo(src);
    }
  }, [src, srcAtivo, tocando, cur, falha]);

  async function alternar() {
    const a = ref.current;
    if (!a) return;
    if (!a.paused) {
      a.pause();
      return;
    }
    setCarregando(true);
    try {
      await a.play();
    } catch (e) {
      setCarregando(false);
      const nome = e instanceof DOMException ? e.name : "";
      // AbortError (pause/nova carga no meio do play) devolve null: não é falha.
      const f = falhaDoPlay(nome, a.error?.code, formatoOk());
      if (f) setFalha(f);
    }
  }

  function buscar(e: ChangeEvent<HTMLInputElement>) {
    const a = ref.current;
    if (!a) return;
    const t = Number(e.target.value);
    a.currentTime = t;
    setCur(t);
  }

  function tentarDeNovo() {
    setFalha(null);
    if (srcAtivo !== src) setSrcAtivo(src); // URL renovada: o efeito de cima já recarrega
    else ref.current?.load();
  }

  const pct = percentual(cur, dur);
  const podeBuscar = duracaoConhecida(dur) && falha === null;

  return (
    <div className="flex w-[17rem] max-w-full items-center gap-2.5">
      <button
        type="button"
        onClick={() => void alternar()}
        disabled={falha !== null}
        aria-label={tocando ? "Pausar áudio" : "Reproduzir áudio"}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white disabled:opacity-40"
      >
        {carregando ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : tocando ? (
          <Pause className="h-3.5 w-3.5" />
        ) : (
          <Play className="ml-0.5 h-3.5 w-3.5" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        {falha !== null ? (
          <>
            <p className="flex items-start gap-1 text-caption leading-snug text-danger-500">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{mensagemDaFalha(falha)}</span>
            </p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-caption">
              {falha !== "formato" && (
                <button type="button" onClick={tentarDeNovo} className="text-brand-500 hover:underline">
                  Tentar de novo
                </button>
              )}
              <a href={srcAtivo} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">
                Abrir o áudio
              </a>
            </p>
          </>
        ) : (
          <>
            <input
              type="range"
              min={0}
              max={podeBuscar ? dur : 1}
              step={0.1}
              value={podeBuscar ? Math.min(cur, dur) : 0}
              onChange={buscar}
              disabled={!podeBuscar}
              aria-label="Posição do áudio"
              aria-valuetext={`${fmtDur(cur)} de ${rotuloDuracao(dur)}`}
              className={
                "block h-1 w-full cursor-pointer appearance-none rounded-full disabled:cursor-default " +
                "[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none " +
                "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500 " +
                "[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full " +
                "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand-500"
              }
              // Trilho preenchido até a posição atual (verde) sobre o cinza do resto.
              style={{
                background: `linear-gradient(to right, hsl(var(--brand-500)) ${pct}%, rgba(0,0,0,0.1) ${pct}%)`,
              }}
            />
            <div className="num mt-1 flex items-center justify-between gap-2 text-caption text-ink-3">
              <span className="whitespace-nowrap">{fmtDur(cur)}</span>
              <span className="whitespace-nowrap">{rotuloDuracao(dur)}</span>
            </div>
          </>
        )}
      </div>

      {falha === null && (
        <button
          type="button"
          onClick={trocarVelocidade}
          aria-label={`Velocidade do áudio: ${rotuloVelocidade(velocidade)}. Clique para mudar`}
          title="Velocidade"
          className="num shrink-0 rounded-full bg-black/10 px-2 py-1 text-caption font-medium leading-none text-ink-2 hover:bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {rotuloVelocidade(velocidade)}
        </button>
      )}
    </div>
  );
}
