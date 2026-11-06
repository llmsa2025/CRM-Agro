# O que ainda falta

O CRM Agro está em evolução. O núcleo funciona de ponta a ponta: contatos, funis, conversas de WhatsApp e e-mail, fluxos de automação, campanhas de disparo pelo WhatsApp, agenda e mapa. As partes abaixo ainda não estão terminadas. A ordem não é de prioridade. Quem quiser ajudar pode pegar qualquer item (veja o [`CONTRIBUTING.md`](CONTRIBUTING.md)).

Legenda: `[ ]` falta fazer. O que já existe hoje vem logo abaixo de cada título. As empresas e os produtos citados aqui são marcas dos seus donos. A lista mostra planos de integração, sem afiliação nem endosso.

## Funis

Hoje: kanban com etapas, negócios com valor e movimentação por arrastar e soltar.

- [ ] Melhorar os formulários do negócio e da etapa.
- [ ] Histórico completo do negócio (mudança de etapa, de valor e de responsável).
- [ ] Tabelas de preço, que ainda não existem, e produtos dentro do negócio.

## Fluxos de automação

Hoje: editor visual com os passos de mensagem, espera, condição, teste A/B, etapa do funil, tag, notificação, requisição HTTP e IA. Dá para criar fluxos dos tipos Prospecção e Enriquecimento.

- [ ] Validar todos os passos, um por um, com teste de ponta a ponta.
- [ ] Criar novos passos personalizados.
- [ ] Refinar as configurações de cada passo.
- [ ] Fluxo do tipo Marketing, com o passo "Postagem" para publicar nas redes sociais. O tipo existe no modelo, mas ainda não dá para criar.

## Conversas

Hoje: WhatsApp e e-mail no mesmo lugar, com busca, filtros, anexos, unificação de conversas e cadastro do contato a partir da conversa.

- [ ] Adicionar a conversa a um fluxo direto da conversa. O botão existe, mas está desligado.
- [ ] Receber as mensagens do LinkedIn em Conversas.

## Campanhas

Hoje: disparo por lista pelo WhatsApp, com limite diário, variações de texto, janela de envio e opt-out.

- [ ] Campanhas de marketing conectadas ao Meta Ads e ao Google Ads.
- [ ] Publicar anúncios e postagens a partir da plataforma.
- [ ] Campanha de postagem no Instagram.

## Redes sociais e canais

Hoje: WhatsApp (pela Evolution API) e e-mail funcionam. Instagram e LinkedIn têm só uma conexão experimental por sessão logada, que pode contrariar os termos dessas plataformas e não é o caminho recomendado.

- [ ] Terminar as integrações oficiais com LinkedIn, Instagram, TikTok e Meta.
- [ ] WhatsApp oficial (Cloud API da Meta), além da Evolution API. O motor já fala com os canais por uma interface comum, então é escrever um novo provedor.

## Integrações

Hoje: Nectar CRM em beta, Google Agenda, Gmail, gatilho por webhook e IA configurável por time.

Enviar o lead pronto para o CRM de quem compra (pensado para quem faz a pré-venda aqui e fecha em outro sistema):

- [ ] RD Station.
- [ ] Agendor.
- [ ] Pipedrive.
- [ ] Reev.
- [ ] Tirar o Nectar CRM do beta.

Marketing e mídia paga:

- [ ] Meta Ads.
- [ ] Google Ads.
- [ ] Outras ferramentas de marketing.

Abertura para outras ferramentas:

- [ ] Webhooks de entrada e de saída, completos e documentados.
- [ ] API própria (REST) para integrar com ferramentas próprias. A tela de Integrações ainda mostra "API pública: em breve".
- [ ] Servidor MCP para IA. Hoje só existe o do verificador de agro, ainda experimental.
- [ ] Gravador de reuniões, como o Plaud ou outro.

## Painel

Hoje: meta do dia, lista de toques, resumo dos funis e atividade recente.

- [ ] Indicadores em dashboards.

## Ligações

- [ ] Terminar a parte de ligar de dentro da plataforma, sem sair para outro aplicativo.
- [ ] Validar o conector de telefonia que existe e acrescentar outros provedores.
- [ ] Agente de IA que faz ligações (voz).

## Qualidade e documentação

Hoje: testes do domínio e das rotas, rodando a cada mudança no GitHub Actions. O fluxo local (instalar, migrar, semear, subir e entrar) é testado pelo workflow "Demo e prints".

- [ ] Testes de ponta a ponta da interface.
- [ ] Testar de ponta a ponta os guias de VPS e de Vercel.
- [ ] Traduzir a documentação para o inglês.
- [ ] Interface em outros idiomas. Hoje só existe em português do Brasil.
