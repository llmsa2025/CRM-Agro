# Prints do CRM Agro

Todos os prints saem da base de demonstração (`pnpm db:seed:demo`): nomes, fazendas, telefones e e-mails **inventados**. Foram gerados pelo script `pnpm demo:screenshots`, então dá para refazer a qualquer momento (veja [`docs/demo-e-prints.md`](../docs/demo-e-prints.md)).

| Pasta | Tamanho | Para quê |
|---|---|---|
| [`linkedin/`](linkedin) | 2400×1257 (proporção 1,91:1) | Imagem de post do LinkedIn (a plataforma reduz sozinha) |
| [`desktop/`](desktop) | 2520×1575 | README, artigos, apresentações |
| [`dark/`](dark) | 2520×1575 | Mesmas telas no tema escuro |

## O que cada tela mostra

| Arquivo | Tela |
|---|---|
| `01-painel` | Painel com a meta do dia, a lista de toques e os funis |
| `02-contatos` | Base de contatos com filtros por tag e por tipo de agro |
| `03-contato-ficha` | Ficha do contato com o histórico unificado |
| `04-conversas` | Inbox de WhatsApp e e-mail no mesmo lugar |
| `05-funil` | Funil de vendas em kanban |
| `06-fluxos` | Lista de fluxos de automação |
| `07-editor-de-fluxo` | Editor visual: mensagem, espera, condição, etapa do funil, tag |
| `08-campanhas` | Campanhas de disparo |
| `09-campanha-andamento` | Campanha em andamento, com status por destinatário |
| `10-agenda` | Agenda de compromissos |
| `11-mapa` | Contatos no mapa |
| `12-captacao` | Captação de contatos |
| `13-integracoes` | Canais e integrações |
| `14-atividades` | Atividades |
| `15-mapa-satelite` | Mapa em satélite, com os contatos soltos, cada um no seu lugar |

## Sugestão de carrossel para o LinkedIn

Ordem que conta a história do produto: `01-painel`, `02-contatos`, `04-conversas`, `05-funil`, `07-editor-de-fluxo`, `15-mapa-satelite`. Use a pasta `linkedin/`.

## Rascunho de texto

> Abri o código do CRM Agro.
>
> É um CRM de prospecção para o agro: uma base única de contatos e um motor de automação em cima dela. Funis em kanban, conversas de WhatsApp em tempo real, fluxos visuais, campanhas, agenda e mapa. Multiempresa, em TypeScript, Next.js e PostgreSQL.
>
> O repositório traz uma base de demonstração e guias para rodar na sua máquina, num VPS ou na Vercel. Se você usa uma IA para programar, aponte para o AGENTS.md e peça para ela colocar no ar.
>
> Código (MIT): https://github.com/llmsa2025/CRM-Agro
