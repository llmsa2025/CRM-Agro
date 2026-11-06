# Arquitetura

A ideia central: **uma base única de contatos (a espinha) e um motor de automação forte em cima dela.** Nada vive preso num módulo; tudo gira em torno do contato.

## Princípios

1. **Contato é a espinha.** Conversa, atividade, negócio no funil e enriquecimento referenciam um `Contact`. "Lead" é só um contato dentro de um funil, não outra entidade.
2. **Orientado a eventos.** Ações relevantes (`message.received`, `stage.changed`, `contact.created`) disparam fluxos e automações. Nada de polling para reagir.
3. **Canais plugáveis.** WhatsApp, e-mail, Instagram e LinkedIn implementam a mesma interface `Channel`. Trocar o WhatsApp não oficial pelo oficial é trocar de provedor, não reescrever o motor.
4. **Validação nas bordas com zod.** Tudo que entra (API, webhook, formulário, resposta de integração) passa por schema; os tipos TypeScript saem do schema.
5. **Regra de negócio na camada de serviço**, não na interface.

## Mapa do monorepo

```
apps/
  web/        Next.js (App Router): telas, rotas de API, servidor próprio com Socket.IO
  worker/     BullMQ: fluxos, esperas, disparos, IA, captação, agenda
  mcp-agro/   Servidor MCP que lê a fila de fotos do verificador de agro (opcional)
packages/
  core/       Domínio: contacts, funnels, flows (o motor), conversations, campaigns, agenda, goals...
  db/         schema.prisma, migrations, client com isolamento por time
  channels/   Provedores: WhatsApp (Evolution API), e-mail (SMTP, IMAP, Gmail), Instagram, LinkedIn
  captation/  Captação: Google Maps, CNPJ, Instagram, sites
  config/     Env validado com zod
```

## Módulos (o menu lateral)

O que ainda falta em cada módulo está no [`ROADMAP.md`](../ROADMAP.md).

| Módulo | O que faz |
|---|---|
| **Painel** | KPIs e o "motor do dia": meta do mês dividida pelos dias úteis vira a lista de toques de hoje (follow-ups vencidos, leads sem primeiro toque, negócios parados) |
| **Contatos** | Cadastro, importação de planilha, enriquecimento por CNPJ, histórico, busca por qualquer dado, verificador de agro (produtor, fazenda, armazém, algodoeira, pecuária, transportadora) |
| **Conversas** | Inbox de WhatsApp e e-mail em tempo real |
| **Funis** | Kanban com arrastar e soltar; mover o negócio dispara `stage.changed` |
| **Fluxos** | Editor visual (React Flow) e o motor que executa |
| **Campanhas** | Disparo por lista com limite diário, variações de texto, janela de envio e opt-out |
| **Agenda** | Compromissos, lembretes, sincronização com Google Agenda |
| **Ligações** | Discador manual e registro de chamadas |
| **Captação** | Google Maps, CNPJ, Instagram: cria contatos a partir de fontes públicas, com pré-visualização antes de salvar |
| **Mapa** | Contatos no mapa, por camada |
| **Integrações** | Canais, IA, dados e CRMs externos |

## O motor de fluxos

Um fluxo é um grafo de nós. Cada contato que entra vira uma `Enrollment` que caminha pelos nós.

- **Gatilhos:** `contact_created`, `stage_changed`, `tag_added`, `message_received`, `webhook`, `manual`, `contacts_selected`.
- **Nós:** `send_message`, `send_email`, `send_social`, `wait`, `typing`, `condition`, `ab_split`, `update_stage`, `create_deal`, `add_tag`, `notify_user`, `http_request`, `ai_agent`, `manual_call`, `enrich_company`, `enrich_person`, `save_history`, `switch_flow`, `end`.
- **Execução (no worker):** o evento cria a `Enrollment` no primeiro nó; o motor executa o nó, resolve o próximo (`nextNodeId` ou `branches`); `wait` agenda um job atrasado no BullMQ; cada passo vira uma `Activity`.
- **Garantias:** idempotência por `enrollmentId + nodeId`, retries com backoff, e o grafo é **congelado** quando o contato entra (versão imutável por hash), então editar o fluxo não muda quem já está dentro.
- **Regra de ouro:** o motor nunca envia direto. Chama a interface `Channel`.

```ts
interface Channel {
  send(input: { to: string; content: MessageContent }): Promise<{ providerMessageId: string }>;
  // mensagens de entrada chegam por webhook, são normalizadas e emitem message.received
}
```

## Multiempresa e permissões

- `teamId` em toda tabela do cliente. Uma extensão do Prisma injeta o filtro em toda leitura e o `teamId` em toda escrita, **fail-closed**: sem time no contexto, zero resultados.
- Id vindo do cliente que vira chave estrangeira passa por `assertOwned` antes de gravar (a extensão filtra `where`, mas não confere FKs no `data`).
- RBAC `owner > admin > member > viewer`. Toda função de escrita do core começa com `requireCan("<ação>")`. O motor, os webhooks e os jobs rodam com `runAsSystem(teamId, fn)`.
- Camada extra opcional: RLS no Postgres por um papel restrito (`DATABASE_URL_APP`).
- Dados sensíveis: tokens de integração cifrados (AES-256-GCM); CPF do contato cifrado; e-mail e telefone do contato com cifra opcional (`CONTATOS_CIFRA`).

## Stack

TypeScript estrito, Next.js (App Router) e React, Tailwind e shadcn/ui, Prisma e PostgreSQL, BullMQ e Redis, Socket.IO, NextAuth v5 (senha e Google, convite, RBAC), React Flow (editor de fluxos), dnd-kit (kanban), zod, Evolution API (WhatsApp).

## O que não está nesta versão pública

A extensão de navegador que roda captação e envio de redes sociais pela sessão e pelo IP do próprio usuário, e os scripts e documentos de operação do ambiente de produção original. O código do servidor que conversa com a extensão continua aqui; sem a extensão, os canais Instagram e LinkedIn por sessão ficam inativos.
