"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, Copy, Loader2, Minus, PanelRightOpen, Plus, SlidersHorizontal, UserPlus, X } from "lucide-react";
import type { Map as MapLibreMap, ExpressionSpecification, GeoJSONSource, MapMouseEvent, Marker, StyleSpecification } from "maplibre-gl";
import type { CamadaDTO, ContatoNoMapaDTO, ContatoPerto, PontosMapa, ResumoMapa, RotaDoDia } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import { RELACIONAMENTO_OPTS, RELACIONAMENTO_STATUS } from "@/components/ui/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBRLCompact, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { copiarTexto } from "@/lib/copiar";
import { createCampaignAction, uploadListAction } from "@/app/campanhas/actions";
import { NovoContatoNoMapa } from "./NovoContatoNoMapa";
import { CamadasDoMapa, SEM_CAMADA } from "./CamadasDoMapa";
import { SeletorSegmentado } from "./SeletorSegmentado";
import { CHAVE_MODO_PONTOS, MODO_PONTOS_PADRAO, configFonteContatos, modoSalvo, visibilidadeCamadas, type ModoPontos } from "./modo-pontos";
import { getContatoResumoAction, listCamadasAction, moverContatosParaCamadaAction } from "./actions";

/**
 * Mapa dos contatos (produto §B.3). MapLibre GL com o estilo público do
 * OpenFreeMap (sem chave). Os pontos são pedidos ao servidor para a região
 * visível (bbox) com os filtros; até 5.000 vêm um a um e o mapa agrupa no
 * cliente (modo "Agrupar") ou mostra todos soltos (modo "Pontos"); acima disso
 * o servidor já devolve os agrupamentos, nos dois modos.
 */

/**
 * Estilos: "mapa" (OpenFreeMap Positron, vetorial) e "satelite" (imagens da
 * Esri World Imagery, raster, com nomes de cidade por cima). Nenhum precisa de
 * chave. Trocar de estilo recria as fontes/camadas: `montarCamadas` roda de
 * novo no `style.load` e os efeitos re-aplicam os dados.
 */
type Estilo = "mapa" | "satelite";
const SATELITE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    satelite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagens © Esri, Maxar, Earthstar Geographics",
    },
    omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
  },
  layers: [
    { id: "satelite", type: "raster", source: "satelite" },
    {
      id: "cidades",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village"]]],
      layout: { "text-field": ["coalesce", ["get", "name:pt"], ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 12 },
      paint: { "text-color": "#FFFFFF", "text-halo-color": "rgba(0,0,0,0.75)", "text-halo-width": 1.2 },
    },
  ],
};
const ESTILOS: Record<Estilo, string | StyleSpecification> = {
  mapa: "https://tiles.openfreemap.org/styles/positron",
  satelite: SATELITE,
};
const CHAVE_ESTILO = "crmagro:mapa:estilo";
/** Painel da direita (resumo + camadas) aberto ou recolhido — lembrado no navegador. */
const CHAVE_PAINEL = "crmagro:mapa:painel";
const BRASIL: [number, number, number, number] = [-74, -34, -34, 5.5];

/** Cor por status — os mesmos tons do StatusDot (globals.css). */
const COR_STATUS: Record<string, string> = {
  novo: "#69706B",
  ja_conversou: "#2F5B8A",
  cliente: "#2F7A45",
  opt_out: "#A8321E",
};

const OPCOES = ["Todos", "Só produtores", "Prováveis produtores", "Não produtores"] as const;
const PRODUTOR: Record<(typeof OPCOES)[number], string> = { Todos: "", "Só produtores": "produtor", "Prováveis produtores": "provavel_produtor", "Não produtores": "nao_produtor" };

type Filtros = {
  status: string[];
  interesse: string;
  produtor: string;
  tag: string;
  cultura: string;
  campanha: string;
  dias: string;
  negocio: string;
  /** Busca parcial na cidade ("sorr" acha Sorriso) e UF. */
  cidade: string;
  uf: string;
  /** Faixas, como a pessoa digitou ("1.000"); o servidor entende pt-BR. */
  areaMin: string;
  areaMax: string;
  fatMin: string;
  fatMax: string;
  /** Camadas desligadas (ids e/ou "__none__"). Vazio = todas visíveis. */
  ocultas: string[];
};
const FILTROS_VAZIOS: Filtros = {
  status: [],
  interesse: "",
  produtor: "",
  tag: "",
  cultura: "",
  campanha: "",
  dias: "",
  negocio: "",
  cidade: "",
  uf: "",
  areaMin: "",
  areaMax: "",
  fatMin: "",
  fatMax: "",
  ocultas: [],
};

type Selecionado = { id: string; nome: string; empresa: string | null; cidade: string | null; st: string; lat: number; lng: number };

/** Pino no estilo do Google Maps (gota com miolo branco), uma cor por status + o dourado da seleção. */
function svgPino(cor: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64" viewBox="0 0 24 32"><path d="M12 1C6.2 1 1.5 5.7 1.5 11.5c0 7.6 9 18.1 9.7 18.9a1.1 1.1 0 0 0 1.6 0c.7-.8 9.7-11.3 9.7-18.9C22.5 5.7 17.8 1 12 1z" fill="${cor}" stroke="#FFFFFF" stroke-width="1.5"/><circle cx="12" cy="11.5" r="4" fill="#FFFFFF"/></svg>`;
}
const PINOS: [string, string][] = [
  ["pino-novo", COR_STATUS.novo!],
  ["pino-ja_conversou", COR_STATUS.ja_conversou!],
  ["pino-cliente", COR_STATUS.cliente!],
  ["pino-opt_out", COR_STATUS.opt_out!],
  ["pino-sel", "#D4A13A"],
];
/** Registra as imagens dos pinos no estilo (48×64 em 2×, para ficar nítido). Trocar de estilo apaga as imagens: roda de novo. */
async function carregarPinos(m: MapLibreMap): Promise<void> {
  await Promise.all(
    PINOS.map(async ([nome, cor]) => {
      if (m.hasImage(nome)) return;
      const img = new Image(48, 64);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgPino(cor))}`;
      await img.decode();
      if (!m.hasImage(nome)) m.addImage(nome, img, { pixelRatio: 2 });
    }),
  );
}

/** Pino por status (padrão, e o que vale para quem está sem camada). */
const ICONE_POR_STATUS = ["match", ["get", "st"], "ja_conversou", "pino-ja_conversou", "cliente", "pino-cliente", "opt_out", "pino-opt_out", "pino-novo"] as unknown as ExpressionSpecification;
const nomePinoCor = (cor: string) => `pino-cor-${cor.replace("#", "").toLowerCase()}`;

/** Registra um pino por cor de camada (trocar de estilo apaga as imagens: roda de novo). */
async function carregarPinosDeCamada(m: MapLibreMap, cores: string[]): Promise<void> {
  await Promise.all(
    [...new Set(cores)].map(async (cor) => {
      const nome = nomePinoCor(cor);
      if (m.hasImage(nome)) return;
      const img = new Image(48, 64);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgPino(cor))}`;
      await img.decode();
      if (!m.hasImage(nome)) m.addImage(nome, img, { pixelRatio: 2 });
    }),
  );
}

/** Contato numa camada ganha o pino da cor dela; sem camada, a cor do status. */
function iconePorCamada(camadas: { id: string; cor: string }[]): ExpressionSpecification {
  if (camadas.length === 0) return ICONE_POR_STATUS;
  return ["match", ["get", "cam"], ...camadas.flatMap((c) => [c.id, nomePinoCor(c.cor)]), ICONE_POR_STATUS] as unknown as ExpressionSpecification;
}

/**
 * Fontes e camadas dos contatos/agrupamentos/rota — roda no `load` e a cada troca de estilo.
 * `modo` decide se a fonte "contatos" agrupa e quais camadas dos contatos aparecem
 * (agrupado: círculos numerados + pinos; pontos: só pontinhos soltos).
 */
async function montarCamadas(m: MapLibreMap, modo: ModoPontos): Promise<void> {
  if (m.getSource("contatos")) return; // já montado neste estilo
  await carregarPinos(m);
  const vis = visibilidadeCamadas(modo);
  m.addSource("contatos", { type: "geojson", data: { type: "FeatureCollection", features: [] }, ...configFonteContatos(modo) });
  m.addSource("grupos", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  m.addSource("rota", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Agrupamentos (cliente): círculo verde-mata com a contagem.
  m.addLayer({
    id: "grupo",
    type: "circle",
    source: "contatos",
    filter: ["has", "point_count"],
    layout: { visibility: vis.grupo },
    paint: {
      "circle-color": "#1F4A3A",
      "circle-opacity": 0.9,
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 22, 200, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#FFFFFF",
    },
  });
  m.addLayer({
    id: "grupo-n",
    type: "symbol",
    source: "contatos",
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Noto Sans Regular"], visibility: vis["grupo-n"] },
    paint: { "text-color": "#FFFFFF" },
  });
  // Agrupamentos do servidor (> 5.000 pontos).
  m.addLayer({
    id: "grupo-srv",
    type: "circle",
    source: "grupos",
    paint: {
      "circle-color": "#1F4A3A",
      "circle-opacity": 0.9,
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 12, 10, 18, 50, 28, 200, 40],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#FFFFFF",
    },
  });
  m.addLayer({
    id: "grupo-srv-n",
    type: "symbol",
    source: "grupos",
    layout: { "text-field": ["to-string", ["get", "n"]], "text-size": 12, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#FFFFFF" },
  });
  // Um ponto por contato, cor pelo status.
  // Um pino por contato (ponta na coordenada), cor pelo status; o selecionado ganha o pino dourado por cima.
  m.addLayer({
    id: "ponto",
    type: "symbol",
    source: "contatos",
    filter: ["!", ["has", "point_count"]],
    layout: {
      visibility: vis.ponto,
      "icon-image": ICONE_POR_STATUS,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.55, 10, 0.8, 14, 1],
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  m.addLayer({
    id: "ponto-sel",
    type: "symbol",
    source: "contatos",
    filter: ["==", ["get", "id"], ""],
    layout: {
      "icon-image": "pino-sel",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 10, 0.95, 14, 1.15],
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  m.addLayer({ id: "rota-linha", type: "line", source: "rota", paint: { "line-color": "#D4A13A", "line-width": 2.5, "line-dasharray": [1.5, 1.5] } });
  m.addLayer({
    id: "rota-parada",
    type: "circle",
    source: "rota",
    filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-color": "#D4A13A", "circle-radius": 11, "circle-stroke-width": 2, "circle-stroke-color": "#FFFFFF" },
  });
  m.addLayer({
    id: "rota-parada-n",
    type: "symbol",
    source: "rota",
    filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["to-string", ["get", "ordem"]], "text-size": 11, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#1A1F1C" },
  });

}

function queryDe(f: Filtros, camadaIds: string[], bbox?: [number, number, number, number]): string {
  const p = new URLSearchParams();
  if (bbox) p.set("bbox", bbox.map((n) => n.toFixed(5)).join(","));
  if (f.status.length) p.set("status", f.status.join(","));
  for (const k of ["interesse", "produtor", "tag", "cultura", "campanha", "dias", "negocio", "cidade", "uf", "areaMin", "areaMax", "fatMin", "fatMax"] as const) {
    if (f[k]) p.set(k, f[k]);
  }
  // Camadas: todas ligadas = sem parâmetro; senão, a lista das ligadas.
  if (f.ocultas.length) {
    const visiveis = [...camadaIds, SEM_CAMADA].filter((id) => !f.ocultas.includes(id));
    if (visiveis.length) p.set("camada", visiveis.join(","));
  }
  return p.toString();
}

/** Campo de texto que só aplica 300 ms depois da última tecla (o mapa não busca a cada letra). */
function CampoAtrasado({
  id,
  valor,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  aceitar,
  className,
  rotulo,
}: {
  id: string;
  valor: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  inputMode?: "decimal" | "text";
  /** Só aplica quando o valor passa (ex.: UF com 0 ou 2 letras). */
  aceitar?: (v: string) => boolean;
  className?: string;
  rotulo?: string;
}) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  useEffect(() => {
    if (v.trim() === valor) return;
    const t = setTimeout(() => {
      if (!aceitar || aceitar(v.trim())) onChange(v.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [v, valor, onChange, aceitar]);
  return (
    <Input
      id={id}
      aria-label={rotulo}
      value={v}
      onChange={(e) => setV(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      className={cn("h-8 text-small", className)}
    />
  );
}

const ufValida = (v: string) => v.length === 0 || v.length === 2;

function Num({ label, valor, sub }: { label: string; valor: string | number; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <span className="text-caption text-ink-2">{label}</span>
      <span className="num font-serif text-h2">{valor}</span>
      {sub && <span className="num text-caption text-ink-3">{sub}</span>}
    </div>
  );
}

export function MapaClient({
  tags,
  campanhas,
  podeEditar,
  podeCampanhas = false,
}: {
  tags: { id: string; nome: string }[];
  campanhas: { id: string; nome: string }[];
  podeEditar: boolean;
  /** Tem a tela Campanhas (F2b): sem ela, "Criar campanha" não aparece. */
  podeCampanhas?: boolean;
}) {
  const router = useRouter();
  const alvo = useRef<HTMLDivElement>(null);
  const mapa = useRef<MapLibreMap | null>(null);
  const [pronto, setPronto] = useState(false);
  const [estilo, setEstilo] = useState<Estilo>("mapa");
  const estiloAplicado = useRef<Estilo>("mapa");
  // Incrementa a cada troca de estilo: os efeitos que gravam dados nas fontes rodam de novo.
  const [versaoEstilo, setVersaoEstilo] = useState(0);
  useEffect(() => {
    try {
      const salvo = localStorage.getItem(CHAVE_ESTILO);
      if (salvo === "satelite") setEstilo("satelite");
    } catch {
      /* sem storage */
    }
  }, []);
  // Agrupar (círculos com número) ou Pontos (todos soltos). Padrão: agrupar; a escolha fica no navegador.
  const [modo, setModo] = useState<ModoPontos>(MODO_PONTOS_PADRAO);
  const modoRef = useRef<ModoPontos>(MODO_PONTOS_PADRAO);
  modoRef.current = modo;
  useEffect(() => {
    try {
      setModo(modoSalvo(localStorage.getItem(CHAVE_MODO_PONTOS)));
    } catch {
      /* sem storage: fica o padrão */
    }
  }, []);
  function escolherModo(novo: ModoPontos) {
    setModo(novo);
    try {
      localStorage.setItem(CHAVE_MODO_PONTOS, novo);
    } catch {
      /* ignora */
    }
  }
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VAZIOS);
  const [filtrosAbertos, setFiltrosAbertos] = useState(true);
  const [dados, setDados] = useState<PontosMapa | null>(null);
  const [resumo, setResumo] = useState<ResumoMapa | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [selecionado, setSelecionado] = useState<Selecionado | null>(null);
  const [perto, setPerto] = useState<ContatoPerto[] | null>(null);
  const [rota, setRota] = useState<RotaDoDia | null>(null);
  const [rotaAberta, setRotaAberta] = useState(false);
  const [pending, start] = useTransition();
  // Camadas (estilo My Maps): lista do time, cores disponíveis e o painel da direita.
  const [camadas, setCamadas] = useState<CamadaDTO[]>([]);
  const [semCamadaTotal, setSemCamadaTotal] = useState(0);
  const [cores, setCores] = useState<string[]>([]);
  const camadasRef = useRef<CamadaDTO[]>([]);
  camadasRef.current = camadas;
  const [painelAberto, setPainelAberto] = useState(true);
  const [resumoSel, setResumoSel] = useState<ContatoNoMapaDTO | null>(null);
  useEffect(() => {
    try {
      if (localStorage.getItem(CHAVE_PAINEL) === "fechado") setPainelAberto(false);
    } catch {
      /* sem storage */
    }
  }, []);
  function alternarPainel(aberto: boolean) {
    setPainelAberto(aberto);
    try {
      localStorage.setItem(CHAVE_PAINEL, aberto ? "aberto" : "fechado");
    } catch {
      /* ignora */
    }
  }
  const recarregarCamadas = useCallback(async () => {
    const r = await listCamadasAction();
    if (!r.ok) return;
    setCamadas(r.camadas);
    setSemCamadaTotal(r.semCamada);
    setCores(r.cores);
  }, []);
  useEffect(() => {
    void recarregarCamadas();
  }, [recarregarCamadas]);
  // Botão direito no mapa → menu no ponto → "Criar contato aqui" (pino dourado enquanto o pop-up está aberto).
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const [menuCtx, setMenuCtx] = useState<{ x: number; y: number; lng: number; lat: number } | null>(null);
  const [novoContato, setNovoContato] = useState<{ lng: number; lat: number } | null>(null);
  const marcadorNovo = useRef<Marker | null>(null);
  const enquadrou = useRef(false);
  const filtrosRef = useRef(filtros);
  filtrosRef.current = filtros;

  const temFiltro = useMemo(() => JSON.stringify(filtros) !== JSON.stringify(FILTROS_VAZIOS), [filtros]);

  // ── Sobe o mapa (MapLibre só no navegador) ───────────────────────────────
  useEffect(() => {
    let cancelado = false;
    let m: MapLibreMap | null = null;
    (async () => {
      const lib = await import("maplibre-gl");
      if (cancelado || !alvo.current) return;
      // MapLibre 6 (ESM): com bundler, o worker precisa vir da nossa origem —
      // copiado para public/maplibre no build (scripts/copiar-maplibre-worker.mjs).
      lib.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      libRef.current = lib;
      m = new lib.Map({
        container: alvo.current,
        style: ESTILOS.mapa,
        bounds: BRASIL,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
      m.touchZoomRotate.disableRotation();
      // Instância acessível pelo DOM (testes E2E conferem camadas/fontes sem depender do React).
      (alvo.current as HTMLDivElement & { __mapa?: MapLibreMap }).__mapa = m;
      m.on("load", async () => {
        if (!m) return;
        await montarCamadas(m, modoRef.current);

        m.on("click", "grupo", (e) => {
          const f = e.features?.[0];
          if (!f || !m) return;
          const src = m.getSource("contatos") as GeoJSONSource;
          src.getClusterExpansionZoom(f.properties!.cluster_id as number).then((z) => m?.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: z }));
        });
        m.on("click", "grupo-srv", (e) => {
          const f = e.features?.[0];
          if (!f || !m) return;
          m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.min(m.getZoom() + 2.5, 12) });
        });
        // Clique no contato: o mesmo pino e o mesmo painel nos dois modos.
        const aoClicarPonto = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string>;
          const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
          setSelecionado({ id: p.id!, nome: p.nome!, empresa: p.empresa || null, cidade: p.cidade || null, st: p.st!, lat, lng });
          setRotaAberta(false);
        };
        m.on("click", "ponto", aoClicarPonto);
        for (const camada of ["ponto", "grupo", "grupo-srv"]) {
          m.on("mouseenter", camada, () => m && (m.getCanvas().style.cursor = "pointer"));
          m.on("mouseleave", camada, () => m && (m.getCanvas().style.cursor = ""));
        }
        // Menu de contexto no ponto clicado; some ao clicar ou mover o mapa.
        m.on("contextmenu", (e) => {
          e.preventDefault();
          setMenuCtx({ x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat });
        });
        m.on("click", () => setMenuCtx(null));
        m.on("movestart", () => setMenuCtx(null));
        mapa.current = m;
        setPronto(true);
      });
    })();
    return () => {
      cancelado = true;
      m?.remove();
      mapa.current = null;
    };
  }, []);

  // Troca de estilo: recria fontes/camadas e avisa os efeitos para re-aplicar os dados.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pronto || estiloAplicado.current === estilo) return;
    estiloAplicado.current = estilo;
    try {
      localStorage.setItem(CHAVE_ESTILO, estilo);
    } catch {
      /* ignora */
    }
    // Ouvinte ANTES do setStyle: com estilo inline o `style.load` dispara de
    // forma síncrona dentro do próprio setStyle e o ouvinte registrado depois
    // perderia o evento (foi assim que os pontos sumiam no satélite).
    m.once("style.load", async () => {
      await montarCamadas(m, modoRef.current);
      setVersaoEstilo((v) => v + 1);
    });
    m.setStyle(ESTILOS[estilo]);
  }, [estilo, pronto]);

  // Troca de modo (ou estilo novo): liga/desliga o agrupamento da fonte e mostra só as camadas do modo.
  // Não recria fonte nem camadas: o worker reprocessa os mesmos dados. Não refaz a busca ao servidor.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pronto) return;
    const cfg = configFonteContatos(modo);
    const src = m.getSource("contatos") as GeoJSONSource | undefined;
    if (src && src.getClusterOptions().cluster !== cfg.cluster) {
      src.setClusterOptions(cfg).catch(() => {
        /* fonte recriada no meio (troca de estilo): a nova já nasce no modo certo */
      });
    }
    for (const [id, visibilidade] of Object.entries(visibilidadeCamadas(modo))) {
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visibilidade);
    }
  }, [modo, pronto, versaoEstilo]);

  // ── Busca pontos + resumo da região visível ──────────────────────────────
  const buscar = useCallback(
    async (comBbox: boolean) => {
      const m = mapa.current;
      if (!m) return;
      const f = filtrosRef.current;
      let bbox: [number, number, number, number] | undefined;
      if (comBbox) {
        const b = m.getBounds();
        bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      }
      setCarregando(true);
      try {
        const q = queryDe(f, camadasRef.current.map((c) => c.id), bbox);
        const [rp, rr] = await Promise.all([fetch(`/api/mapa/pontos?${q}`), fetch(`/api/mapa/resumo?${q}`)]);
        if (rp.status === 400) toast.error("Filtro inválido", { description: "Confira as faixas de área e faturamento (o mínimo não pode passar do máximo)." });
        if (rp.ok) {
          const pts = (await rp.json()) as PontosMapa;
          setDados(pts);
          const srcPontos = m.getSource("contatos") as GeoJSONSource | undefined;
          const srcGrupos = m.getSource("grupos") as GeoJSONSource | undefined;
          if (pts.tipo === "pontos") {
            srcPontos?.setData({
              type: "FeatureCollection",
              features: pts.ids.map((id, i) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [pts.lng[i]!, pts.lat[i]!] },
                properties: { id, st: pts.st[i], nome: pts.nome[i], empresa: pts.empresa[i] ?? "", cidade: pts.cidade[i] ?? "", cam: pts.cam[i] ?? "" },
              })),
            });
            srcGrupos?.setData({ type: "FeatureCollection", features: [] });
            // Primeira carga: enquadra o mapa nos contatos.
            if (!comBbox && !enquadrou.current && pts.ids.length > 0) {
              enquadrou.current = true;
              let w = 180, s = 90, e = -180, n = -90;
              for (let i = 0; i < pts.ids.length; i++) {
                w = Math.min(w, pts.lng[i]!); e = Math.max(e, pts.lng[i]!);
                s = Math.min(s, pts.lat[i]!); n = Math.max(n, pts.lat[i]!);
              }
              m.fitBounds([w, s, e, n], { padding: 60, maxZoom: 11, duration: 600 });
            }
          } else {
            srcPontos?.setData({ type: "FeatureCollection", features: [] });
            srcGrupos?.setData({
              type: "FeatureCollection",
              features: pts.clusters.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lng, c.lat] }, properties: { n: c.n } })),
            });
            if (!comBbox && !enquadrou.current && pts.clusters.length > 0) {
              enquadrou.current = true;
              let w = 180, s = 90, e = -180, n = -90;
              for (const c of pts.clusters) {
                w = Math.min(w, c.lng); e = Math.max(e, c.lng);
                s = Math.min(s, c.lat); n = Math.max(n, c.lat);
              }
              m.fitBounds([w, s, e, n], { padding: 60, maxZoom: 9, duration: 600 });
            }
          }
        }
        if (rr.ok) setResumo((await rr.json()) as ResumoMapa);
      } catch {
        toast.error("Não consegui carregar o mapa");
      } finally {
        setCarregando(false);
      }
    },
    [],
  );

  // Primeira carga (sem bbox) e, depois, a cada movimento (com bbox, com atraso).
  useEffect(() => {
    if (!pronto) return;
    const m = mapa.current!;
    void buscar(false);
    let t: ReturnType<typeof setTimeout> | null = null;
    const aoMover = () => {
      if (!enquadrou.current) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void buscar(true), 350);
    };
    m.on("moveend", aoMover);
    return () => {
      m.off("moveend", aoMover);
      if (t) clearTimeout(t);
    };
  }, [pronto, buscar]);

  // Filtro, camadas (ou estilo) mudaram: recarrega a região visível.
  useEffect(() => {
    if (!pronto) return;
    void buscar(enquadrou.current);
  }, [filtros, camadas, pronto, buscar, versaoEstilo]);

  // Pinos pela cor da camada (e de novo depois de trocar de estilo, que apaga as imagens).
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pronto) return;
    let vivo = true;
    void (async () => {
      await carregarPinosDeCamada(m, camadas.map((c) => c.cor));
      if (vivo && m.getLayer("ponto")) m.setLayoutProperty("ponto", "icon-image", iconePorCamada(camadas));
    })();
    return () => {
      vivo = false;
    };
  }, [camadas, pronto, versaoEstilo]);

  // Camada, área e faturamento do contato escolhido (fora do payload do mapa).
  useEffect(() => {
    setResumoSel(null);
    if (!selecionado) return;
    let vivo = true;
    void getContatoResumoAction(selecionado.id).then((r) => {
      if (vivo && r.ok) setResumoSel(r.contato);
    });
    return () => {
      vivo = false;
    };
  }, [selecionado]);

  function moverSelecionado(camadaId: string | null) {
    if (!selecionado) return;
    const id = selecionado.id;
    start(async () => {
      const r = await moverContatosParaCamadaAction([id], camadaId);
      if (!r.ok) return void toast.error("Não deu para mudar a camada", { description: r.error });
      setResumoSel((s) => (s && s.id === id ? { ...s, camadaId } : s));
      toast.success(camadaId ? `Movido para ${camadas.find((c) => c.id === camadaId)?.nome ?? "a camada"}` : "Tirado da camada");
      void recarregarCamadas();
    });
  }

  // Anel dourado no contato escolhido + contatos por perto.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pronto) return;
    m.setFilter("ponto-sel", ["==", ["get", "id"], selecionado?.id ?? ""]);
    setPerto(null);
    if (!selecionado) return;
    fetch(`/api/mapa/perto?contactId=${selecionado.id}&km=30`)
      .then((r) => (r.ok ? (r.json() as Promise<ContatoPerto[]>) : []))
      .then(setPerto)
      .catch(() => setPerto([]));
  }, [selecionado, pronto, versaoEstilo]);

  // Pino dourado no ponto escolhido enquanto o pop-up de novo contato está aberto.
  useEffect(() => {
    const m = mapa.current;
    const lib = libRef.current;
    marcadorNovo.current?.remove();
    marcadorNovo.current = null;
    if (!m || !lib || !novoContato) return;
    marcadorNovo.current = new lib.Marker({ color: "#D4A13A" }).setLngLat([novoContato.lng, novoContato.lat]).addTo(m);
    return () => {
      marcadorNovo.current?.remove();
      marcadorNovo.current = null;
    };
  }, [novoContato]);

  // Rota do dia desenhada no mapa.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pronto) return;
    const src = m.getSource("rota") as GeoJSONSource | undefined;
    if (!src) return;
    if (!rota || rota.paradas.length === 0) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const coords = rota.paradas.map((p) => [p.lng, p.lat] as [number, number]);
    src.setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} },
        ...rota.paradas.map((p, i) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] }, properties: { ordem: i + 1 } })),
      ],
    });
    let w = 180, s = 90, e = -180, n = -90;
    for (const c of coords) {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    }
    m.fitBounds([w, s, e, n], { padding: 80, maxZoom: 12, duration: 600 });
  }, [rota, pronto, versaoEstilo]);

  function rotaDoDia() {
    setRotaAberta(true);
    setSelecionado(null);
    const pedir = (origem?: { lat: number; lng: number }) =>
      start(async () => {
        const r = await fetch("/api/mapa/rota", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(origem ? { origem } : {}) });
        if (!r.ok) {
          toast.error("Não consegui montar a rota");
          return;
        }
        setRota((await r.json()) as RotaDoDia);
      });
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => pedir({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => pedir(),
        { timeout: 4000, maximumAge: 300_000 },
      );
    } else pedir();
  }

  function criarCampanha() {
    if (!dados || dados.tipo !== "pontos" || dados.ids.length === 0) return;
    const ids = dados.ids;
    if (!confirm(`Criar uma campanha com os ${ids.length} contatos da região visível?`)) return;
    start(async () => {
      const nome = `Mapa · ${ids.length} contatos · ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date())}`;
      const c = await createCampaignAction(nome);
      if (!c.ok) {
        toast.error("Não deu para criar a campanha", { description: c.error });
        return;
      }
      const fd = new FormData();
      fd.set("campaignId", c.campaign.id);
      fd.set("contactIds", JSON.stringify(ids));
      const u = await uploadListAction(fd);
      if (!u.ok) toast.error("Campanha criada, mas a lista não entrou", { description: u.error });
      router.push(`/campanhas/${c.campaign.id}`);
    });
  }

  const linkContatos = useMemo(() => {
    const p = new URLSearchParams();
    if (filtros.status.length === 1) p.set("status", filtros.status[0]!);
    if (filtros.interesse) p.set("interesse", filtros.interesse);
    if (filtros.tag) p.set("tag", filtros.tag);
    if (filtros.produtor) p.set("produtor", filtros.produtor);
    const q = p.toString();
    return q ? `/contatos?${q}` : "/contatos";
  }, [filtros]);

  const total = resumo?.total ?? (dados?.total ?? 0);
  const vazio = pronto && !carregando && dados !== null && dados.total === 0;

  return (
    <div className="relative flex h-[calc(100dvh-52px)] min-h-0 overflow-hidden bg-muted/30">
      {/* ── Filtros (esquerda) ── */}
      <aside className={cn("z-10 flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-background transition-[margin]", !filtrosAbertos && "-ml-[272px]")}>
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <h1 className="font-serif text-[17px]">Mapa</h1>
          <button type="button" aria-label="Recolher filtros" onClick={() => setFiltrosAbertos(false)} className="rounded p-1 text-ink-3 hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <fieldset className="border-b border-line pb-4">
            <legend className="mb-2 text-caption font-medium uppercase tracking-wide text-ink-3">Status</legend>
            <div className="flex flex-col gap-2">
              {RELACIONAMENTO_OPTS.map((o) => {
                const on = filtros.status.includes(o.value);
                return (
                  <label key={o.value} className="flex cursor-pointer items-center gap-2.5 text-small">
                    <Checkbox checked={on} onCheckedChange={(v) => setFiltros((f) => ({ ...f, status: v ? [...f.status, o.value] : f.status.filter((s) => s !== o.value) }))} />
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: COR_STATUS[o.value] }} aria-hidden />
                    <span className="flex-1">{o.label}</span>
                    {resumo?.porStatus[o.value] ? <span className="num text-caption text-ink-3">{resumo.porStatus[o.value]}</span> : null}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex flex-col gap-3 pt-4">
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Produtor</Label>
              <Select value={filtros.produtor || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, produtor: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OPCOES.map((o) => (
                    <SelectItem key={o} value={PRODUTOR[o] || "__"}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Interesse</Label>
              <Select value={filtros.interesse || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, interesse: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__">Qualquer</SelectItem>
                  <SelectItem value="interessado">Interessado</SelectItem>
                  <SelectItem value="talvez">Talvez</SelectItem>
                  <SelectItem value="nao_avaliado">Não avaliado</SelectItem>
                  <SelectItem value="sem_interesse">Sem interesse</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Cultura</Label>
              <Select value={filtros.cultura || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, cultura: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__">Qualquer</SelectItem>
                  {(resumo?.culturas ?? []).map((c) => (
                    <SelectItem key={c.nome} value={c.nome}>{c.nome}</SelectItem>
                  ))}
                  {filtros.cultura && !(resumo?.culturas ?? []).some((c) => c.nome === filtros.cultura) && <SelectItem value={filtros.cultura}>{filtros.cultura}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Tag</Label>
              <Select value={filtros.tag || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, tag: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__">Qualquer</SelectItem>
                  <SelectItem value="__none__">Sem tag</SelectItem>
                  {tags.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {campanhas.length > 0 && (
              <div className="grid gap-1">
                <Label className="text-caption text-ink-2">Recebeu a campanha</Label>
                <Select value={filtros.campanha || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, campanha: v === "__" ? "" : v }))}>
                  <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__">Qualquer</SelectItem>
                    {campanhas.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Teve interação</Label>
              <Select value={filtros.dias || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, dias: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__">Qualquer época</SelectItem>
                  <SelectItem value="7">Últimos 7 dias</SelectItem>
                  <SelectItem value="30">Últimos 30 dias</SelectItem>
                  <SelectItem value="90">Últimos 90 dias</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-caption text-ink-2">Negócio</Label>
              <Select value={filtros.negocio || "__"} onValueChange={(v) => setFiltros((f) => ({ ...f, negocio: v === "__" ? "" : v }))}>
                <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__">Tanto faz</SelectItem>
                  <SelectItem value="aberto">Com negócio aberto</SelectItem>
                  <SelectItem value="sem">Sem negócio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[1fr_64px] gap-2">
              <div className="grid gap-1">
                <Label htmlFor="f-cidade" className="text-caption text-ink-2">Cidade</Label>
                <CampoAtrasado id="f-cidade" valor={filtros.cidade} onChange={(v) => setFiltros((f) => ({ ...f, cidade: v }))} placeholder="Sorriso" maxLength={80} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-uf" className="text-caption text-ink-2">UF</Label>
                <CampoAtrasado id="f-uf" valor={filtros.uf} onChange={(v) => setFiltros((f) => ({ ...f, uf: v.toUpperCase() }))} placeholder="MT" maxLength={2} aceitar={ufValida} className="uppercase" />
              </div>
            </div>
            <div className="grid gap-1">
              <span className="text-caption text-ink-2">Área (ha)</span>
              <div className="grid grid-cols-2 gap-2">
                <CampoAtrasado id="f-area-min" rotulo="Área mínima (ha)" valor={filtros.areaMin} onChange={(v) => setFiltros((f) => ({ ...f, areaMin: v }))} placeholder="de" inputMode="decimal" maxLength={15} />
                <CampoAtrasado id="f-area-max" rotulo="Área máxima (ha)" valor={filtros.areaMax} onChange={(v) => setFiltros((f) => ({ ...f, areaMax: v }))} placeholder="até" inputMode="decimal" maxLength={15} />
              </div>
            </div>
            <div className="grid gap-1">
              <span className="text-caption text-ink-2">Faturamento anual (R$)</span>
              <div className="grid grid-cols-2 gap-2">
                <CampoAtrasado id="f-fat-min" rotulo="Faturamento mínimo (R$)" valor={filtros.fatMin} onChange={(v) => setFiltros((f) => ({ ...f, fatMin: v }))} placeholder="de" inputMode="decimal" maxLength={20} />
                <CampoAtrasado id="f-fat-max" rotulo="Faturamento máximo (R$)" valor={filtros.fatMax} onChange={(v) => setFiltros((f) => ({ ...f, fatMax: v }))} placeholder="até" inputMode="decimal" maxLength={20} />
              </div>
            </div>
          </div>
          {temFiltro && (
            <button type="button" onClick={() => setFiltros(FILTROS_VAZIOS)} className="mt-4 text-small font-medium text-brand-500 hover:underline">
              Limpar filtros
            </button>
          )}
        </div>
        <div className="border-t border-line px-4 py-3">
          {podeEditar && <p className="mb-2 text-caption text-ink-3">Botão direito no mapa: criar um contato naquele ponto.</p>}
          <div className="flex flex-col gap-2 text-caption text-ink-3">
            {camadas.length > 0 ? (
              <>
                {camadas.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.cor }} aria-hidden />
                    <span className="truncate">{c.nome}</span>
                  </span>
                ))}
                <span className="text-ink-3">Sem camada: cor do status</span>
              </>
            ) : (
              RELACIONAMENTO_OPTS.map((o) => (
                <span key={o.value} className="inline-flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: COR_STATUS[o.value] }} aria-hidden />
                  {o.label}
                </span>
              ))
            )}
          </div>
        </div>
      </aside>

      {/* ── Mapa ── */}
      <div className="relative h-full min-w-0 flex-1">
        {/* O CSS do MapLibre força `position: relative` no contêiner, então o tamanho vem de h-full/w-full (não de inset-0). */}
        <div ref={alvo} className="h-full w-full" />

        {menuCtx && (
          <div
            role="menu"
            className="absolute z-20 w-52 rounded-md border border-line bg-background p-1 shadow-md"
            style={{ left: Math.min(menuCtx.x, (alvo.current?.clientWidth ?? 9999) - 216), top: Math.min(menuCtx.y, (alvo.current?.clientHeight ?? 9999) - 80) }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {podeEditar && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNovoContato({ lng: menuCtx.lng, lat: menuCtx.lat });
                  setMenuCtx(null);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-small hover:bg-accent"
              >
                <UserPlus className="h-4 w-4 text-ink-3" /> Criar contato aqui
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                const coords = `${menuCtx.lat.toFixed(6)}, ${menuCtx.lng.toFixed(6)}`;
                const ok = await copiarTexto(coords);
                setMenuCtx(null);
                if (ok) toast.success("Coordenadas copiadas");
                // Na falha, mostra as coordenadas no aviso para a pessoa copiar na mão.
                else toast.error("Não consegui copiar as coordenadas.", { description: coords });
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-small hover:bg-accent"
            >
              <Copy className="h-4 w-4 text-ink-3" /> Copiar coordenadas
            </button>
          </div>
        )}

        <NovoContatoNoMapa
          ponto={novoContato}
          camadas={camadas}
          onClose={() => setNovoContato(null)}
          onCreated={(c) => {
            const p = novoContato;
            setNovoContato(null);
            void buscar(true);
            if (c.camadaId) void recarregarCamadas();
            if (p) {
              setSelecionado({ id: c.id, nome: c.nome, empresa: c.empresa, cidade: c.cidade, st: "novo", lat: p.lat, lng: p.lng });
              mapa.current?.easeTo({ center: [p.lng, p.lat] });
            }
          }}
        />

        {/* Barra do topo sobre o mapa */}
        <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-2">
            {!filtrosAbertos && (
              <Button variant="outline" size="sm" className="bg-background" onClick={() => setFiltrosAbertos(true)}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filtros
              </Button>
            )}
            <div className="num rounded-md border border-line bg-background px-3 py-1.5 text-small shadow-sm">
              {carregando ? <Loader2 className="inline h-3.5 w-3.5 animate-spin text-ink-3" /> : <span className="font-medium">{total}</span>} {total === 1 ? "contato" : "contatos"} na região
              {dados?.tipo === "clusters" && <span className="text-ink-3"> · aproxime para ver um a um</span>}
            </div>
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="bg-background" onClick={rotaDoDia} disabled={pending}>
              Rota do dia
            </Button>
            <Button variant="outline" size="sm" className="bg-background" asChild>
              <Link href={linkContatos}>Ver em Contatos</Link>
            </Button>
            {podeCampanhas && (
              <Button size="sm" onClick={criarCampanha} disabled={pending || !dados || dados.tipo !== "pontos" || dados.ids.length === 0}>
                Criar campanha
              </Button>
            )}
          </div>
        </div>

        {/* Modo dos contatos (Agrupar | Pontos) + estilo (Mapa | Satélite) + zoom.
            `items-start`: cada caixa do tamanho do próprio conteúdo (sem ele a do zoom
            esticava até a largura dos seletores). */}
        <div className="absolute bottom-6 left-3 z-10 flex flex-col items-start gap-2">
        {/* Um em cima do outro (Agrupar | Pontos acima de Mapa | Satélite): ocupa altura, não largura do mapa. */}
        <div className="flex flex-col items-start gap-2">
          <SeletorSegmentado
            rotulo="Exibição dos contatos"
            valor={modo}
            opcoes={[
              { valor: "agrupar", rotulo: "Agrupar", dica: "Junta os contatos próximos num círculo com o número" },
              { valor: "pontos", rotulo: "Pontos", dica: "Mostra cada contato como um ponto solto, sem agrupar" },
            ]}
            onChange={escolherModo}
          />
          <SeletorSegmentado
            rotulo="Tipo de mapa"
            valor={estilo}
            opcoes={[
              { valor: "mapa", rotulo: "Mapa" },
              { valor: "satelite", rotulo: "Satélite" },
            ]}
            onChange={setEstilo}
          />
        </div>
        <div className="flex flex-col overflow-hidden rounded-md border border-line bg-background shadow-sm">
          <button type="button" aria-label="Aproximar" onClick={() => mapa.current?.zoomIn()} className="flex h-8 w-8 items-center justify-center text-ink-2 hover:bg-accent">
            <Plus className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Afastar" onClick={() => mapa.current?.zoomOut()} className="flex h-8 w-8 items-center justify-center border-t border-line text-ink-2 hover:bg-accent">
            <Minus className="h-4 w-4" />
          </button>
        </div>
        </div>

        {vazio && (
          <div className="absolute inset-x-0 top-1/2 z-10 mx-auto max-w-sm -translate-y-1/2 rounded-md border border-line bg-background p-5 text-center shadow-sm">
            <p className="text-body font-medium">{temFiltro ? "Nenhum contato com esses filtros aqui" : "Nenhum contato localizado ainda"}</p>
            <p className="pt-1.5 text-small leading-relaxed text-ink-2">
              {temFiltro ? "Afaste o mapa ou limpe os filtros." : "O CRM Agro localiza cada contato pelo endereço ou pela cidade, em segundo plano. Cadastre cidade e estado nos contatos e eles aparecem aqui."}
            </p>
          </div>
        )}

        {/* ── Painel direito: resumo · contato · rota ── */}
        <aside className="pointer-events-none absolute bottom-6 right-3 top-14 z-10 flex w-[300px] flex-col items-end gap-3">
          {selecionado ? (
            <section className="pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-md border border-line bg-background shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-body font-medium">{selecionado.nome}</div>
                  <div className="truncate text-small text-ink-2">{[selecionado.empresa, selecionado.cidade].filter(Boolean).join(" · ") || "—"}</div>
                  <div className="pt-1.5">
                    <StatusDot tone={RELACIONAMENTO_STATUS[selecionado.st]?.tone ?? "done"}>{RELACIONAMENTO_STATUS[selecionado.st]?.label ?? selecionado.st}</StatusDot>
                  </div>
                  {resumoSel && (resumoSel.areaHa != null || resumoSel.faturamentoAnual != null) && (
                    <div className="num pt-1.5 text-caption text-ink-2">
                      {[
                        resumoSel.areaHa != null ? `${resumoSel.areaHa.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ha` : null,
                        resumoSel.faturamentoAnual != null ? `${formatBRLCompact(resumoSel.faturamentoAnual)}/ano` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                </div>
                <button type="button" aria-label="Fechar" onClick={() => setSelecionado(null)} className="rounded p-1 text-ink-3 hover:bg-accent hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2 px-4 py-3">
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <Link href={`/contatos/${selecionado.id}`}>Ficha</Link>
                </Button>
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <Link href={`/conversas?contact=${selecionado.id}&canal=whatsapp`}>Conversa</Link>
                </Button>
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <Link href={`/agenda?contact=${selecionado.id}&nome=${encodeURIComponent(selecionado.nome)}&tipo=visita`}>Visita</Link>
                </Button>
              </div>
              <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
                <span className="text-caption text-ink-2">Camada</span>
                <Select
                  value={resumoSel?.camadaId ?? SEM_CAMADA}
                  onValueChange={(v) => moverSelecionado(v === SEM_CAMADA ? null : v)}
                  disabled={!podeEditar || !resumoSel || pending}
                >
                  <SelectTrigger className="h-8 flex-1 text-small" aria-label="Camada do contato">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SEM_CAMADA}>Sem camada</SelectItem>
                    {camadas.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="inline-flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ background: c.cor }} aria-hidden />
                          {c.nome}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-caption font-medium uppercase tracking-wide text-ink-3">Perto daqui · 30 km</span>
                  {perto && <span className="num text-caption text-ink-3">{perto.length}</span>}
                </div>
                {perto === null ? (
                  <p className="py-3 text-small text-ink-3">Procurando…</p>
                ) : perto.length === 0 ? (
                  <p className="py-3 text-small text-ink-2">Ninguém num raio de 30 km.</p>
                ) : (
                  perto.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setSelecionado({ id: p.id, nome: p.nome, empresa: p.empresa, cidade: p.cidade, st: p.st, lat: p.lat, lng: p.lng });
                        mapa.current?.easeTo({ center: [p.lng, p.lat] });
                      }}
                      className="flex w-full items-center gap-2.5 border-b border-line py-2 text-left text-small last:border-b-0 hover:bg-accent/60"
                    >
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: COR_STATUS[p.st] ?? "#69706B" }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {p.nome}
                        {p.cidade && <span className="text-ink-3"> · {p.cidade}</span>}
                      </span>
                      <span className="num shrink-0 text-caption text-ink-3">{p.km < 1 ? "<1" : Math.round(p.km)} km</span>
                    </button>
                  ))
                )}
              </div>
            </section>
          ) : rotaAberta ? (
            <section className="pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-md border border-line bg-background shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <div className="text-body font-medium">Rota de hoje</div>
                  <div className="num text-small text-ink-2">
                    {rota ? `${rota.paradas.length} ${rota.paradas.length === 1 ? "parada" : "paradas"} · ${Math.round(rota.totalKm)} km em linha reta` : "Montando…"}
                  </div>
                </div>
                <button type="button" aria-label="Fechar" onClick={() => { setRotaAberta(false); setRota(null); }} className="rounded p-1 text-ink-3 hover:bg-accent hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                {rota && rota.paradas.length === 0 && rota.semLocal.length === 0 && <p className="py-3 text-small text-ink-2">Nenhum compromisso pendente hoje.</p>}
                {rota?.paradas.map((p, i) => (
                  <div key={p.appointmentId} className="flex items-start gap-3 border-b border-line py-2.5 text-small last:border-b-0">
                    <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#D4A13A] text-caption text-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.nome}</div>
                      <div className="num truncate text-caption text-ink-2">
                        {formatTime(p.inicio)} · {p.titulo}
                        {p.cidade ? ` · ${p.cidade}` : ""}
                      </div>
                    </div>
                    <span className="num shrink-0 text-caption text-ink-3">{i === 0 && !p.km ? "" : `${Math.round(p.km)} km`}</span>
                  </div>
                ))}
                {rota && rota.semLocal.length > 0 && (
                  <div className="pt-3">
                    <div className="text-caption font-medium uppercase tracking-wide text-ink-3">Sem local ({rota.semLocal.length})</div>
                    {rota.semLocal.map((s) => (
                      <div key={s.appointmentId} className="num flex justify-between gap-3 py-1.5 text-small text-ink-2">
                        <span className="truncate">{s.titulo}</span>
                        <span className="shrink-0">{formatTime(s.inicio)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {rota?.linkGoogleMaps && (
                <div className="border-t border-line px-4 py-3">
                  <Button asChild size="sm" className="w-full">
                    <a href={rota.linkGoogleMaps} target="_blank" rel="noreferrer">
                      Abrir no Google Maps{rota.linkParcial ? " (primeiras paradas)" : ""}
                    </a>
                  </Button>
                </div>
              )}
            </section>
          ) : painelAberto ? (
            <section className="pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-md border border-line bg-background shadow-sm">
              <div className="flex items-center justify-between border-b border-line py-2 pl-4 pr-2">
                <div className="text-caption font-medium uppercase tracking-wide text-ink-3">Região visível</div>
                <button type="button" aria-label="Recolher resumo" title="Recolher" onClick={() => alternarPainel(false)} className="rounded p-1 text-ink-3 hover:bg-accent hover:text-foreground">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4">
                {resumo && (
                  <div className="grid grid-cols-2 gap-x-4">
                    <Num label="Contatos" valor={resumo.total} />
                    <Num label="Responderam" valor={resumo.responderam} sub={resumo.total ? `${Math.round((resumo.responderam / resumo.total) * 100)}%` : undefined} />
                    <Num label="Clientes" valor={resumo.clientes} />
                    <Num label="Negócios abertos" valor={resumo.negociosAbertos.n} sub={resumo.negociosAbertos.valor ? formatBRLCompact(resumo.negociosAbertos.valor) : undefined} />
                  </div>
                )}
                {resumo && resumo.area.comArea > 0 && (
                  <p className="num pb-2 text-caption text-ink-2">
                    {resumo.area.totalHa.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} ha somados · {resumo.area.comArea} com área informada
                  </p>
                )}
                <CamadasDoMapa
                  camadas={camadas}
                  semCamadaTotal={semCamadaTotal}
                  cores={cores}
                  porCamada={resumo?.porCamada ?? null}
                  ocultas={filtros.ocultas}
                  onAlternar={(id, visivel) =>
                    setFiltros((f) => ({ ...f, ocultas: visivel ? f.ocultas.filter((x) => x !== id) : [...f.ocultas, id] }))
                  }
                  podeEditar={podeEditar}
                  idsVisiveis={dados?.tipo === "pontos" ? dados.ids : null}
                  emAgrupamento={dados?.tipo === "clusters"}
                  onMudou={() => void recarregarCamadas()}
                />
                {resumo && (resumo.culturas.length > 0 || resumo.cidades.length > 0) && (
                  <details className="border-t border-line py-3">
                    <summary className="cursor-pointer select-none text-caption text-ink-2 hover:text-foreground">Ver culturas e cidades</summary>
                    {resumo.culturas.length > 0 && (
                      <div className="pt-3">
                        <div className="text-caption text-ink-2">Culturas</div>
                        <div className="flex flex-col gap-1.5 pt-2">
                          {resumo.culturas.slice(0, 5).map((c) => (
                            <button key={c.nome} type="button" onClick={() => setFiltros((f) => ({ ...f, cultura: f.cultura === c.nome ? "" : c.nome }))} className="num flex items-center gap-2 text-left text-small hover:text-brand-500">
                              <span className="w-24 truncate">{c.nome}</span>
                              <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full bg-brand-500" style={{ width: `${Math.max(2, c.pct)}%` }} />
                              </span>
                              <span className="w-9 text-right text-ink-3">{c.pct}%</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {resumo.cidades.length > 0 && (
                      <div className="pt-3">
                        <div className="text-caption text-ink-2">Cidades</div>
                        <div className="flex flex-col pt-1">
                          {resumo.cidades.slice(0, 8).map((c) => (
                            <button
                              key={`${c.nome}-${c.uf}`}
                              type="button"
                              onClick={() => setFiltros((f) => ({ ...f, cidade: f.cidade === c.nome ? "" : c.nome }))}
                              className="num flex justify-between gap-3 py-1 text-left text-small hover:text-brand-500"
                            >
                              <span className="truncate">
                                {c.nome}
                                {c.uf && <span className="text-ink-3"> · {c.uf}</span>}
                              </span>
                              <span className="text-ink-3">{c.n}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </details>
                )}
              </div>
            </section>
          ) : (
            <button
              type="button"
              aria-label="Abrir resumo"
              title="Abrir resumo"
              onClick={() => alternarPainel(true)}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-md border border-line bg-background text-ink-2 shadow-sm hover:bg-accent hover:text-foreground"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
