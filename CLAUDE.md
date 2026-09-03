# CLAUDE.md — Secullum CRM

Instruções permanentes deste repositório. O Claude Code lê este arquivo no
início de toda sessão.

## Como trabalhar aqui

**Antes de entregar qualquer alteração, valide:**

```bash
# Frontend — o React é JSX, o esbuild precisa da extensão certa
cp src/App.js src/App.check.jsx
npx esbuild src/App.check.jsx --bundle --outfile=/dev/null \
  --external:react --external:react-dom --external:firebase/* \
  --external:./firebase --external:xlsx --external:jspdf \
  --external:docx --external:file-saver
rm src/App.check.jsx

# Backend
node --check functions/index.js
```

Zero erro é obrigatório. Avisos de chave duplicada já existem e estão mapeados
na seção de pendências — não são regressão.

**Regras de trabalho neste projeto:**

1. **Valide a ideia antes de escrever código.** O dono do projeto pediu isso
   explicitamente: *"não gere nada ainda, vamos ser cuidadosos para não gerar
   lixo, tudo que temos já funciona, vamos com cuidado."* Proponha, confirme,
   depois construa.
2. **Nunca `git add .`** — sempre nomeie os arquivos.
3. **Teste antes de entregar.** Renderize o documento, rode o cálculo, simule a
   tela. Este projeto tem histórico de bug encontrado no próprio teste antes de
   chegar no usuário — mantenha isso.
4. **Comentário no código explica o PORQUÊ**, de preferência contando o erro
   que aquilo evita. Não descreva o que a linha faz.
5. **Português do Brasil** em tudo: nomes de variável, comentário, texto de
   tela. O código existente segue isso.
6. **Alteração destrutiva pede justificativa escrita** e vai para uma coleção de
   removidos — nada é apagado de verdade.

---


## 1. O negócio

**Guion Informática** é revenda Secullum. Vende sistema de controle de ponto
("ponto") para empresas no Brasil: licença mensal do software + relógio de
ponto (equipamento) + implantação.

**Andreus Calodiano** é quem toca o projeto. Time inclui Nicolau, Matheus,
Rafael, Gabriel (vendedores que aparecem nos dados).

Três planos: **Basic**, **Pro**, **Ultimate**. Equipamento principal nos dados
é o **EVO Facial 40** (reconhecimento facial).

O CRM foi construído sob medida para essa operação. Não é produto genérico:
cada tela existe porque resolvia um problema real do dia a dia.

---

## 2. O sistema

### Stack

- **Frontend**: React em arquivo único — `src/App.js`, ~22.200 linhas, 1,3 MB.
  Estilos **inline** (`style={{...}}`), sem CSS externo, sem framework de UI.
- **Backend**: Firebase Cloud Functions — `functions/index.js`, ~5.900 linhas,
  Node 20.
- **Banco**: Firestore, com `onSnapshot` (tempo real) em quase tudo.
- **Arquivos**: Firebase Storage.
- **Hospedagem do front**: Vercel.

### Deploy — são DOIS, separados

```bash
# 1. Frontend  →  a Vercel publica sozinha depois do push
git add src/App.js
git commit -m "..."
git push

# 2. Backend  →  NÃO sai no push, tem que rodar à mão
firebase deploy --only functions:nomeDaFuncao
```

**O segundo passo é o mais esquecido do projeto.** Sintoma clássico: a tela
nova aparece, mas o botão dela responde "Sem conexão" ou não faz nada — porque
a function ainda não subiu.

### Repositório

`andreuscalodiano-png/secullum-crm` — **PÚBLICO**.

---

## 3. Regras de segurança que não se quebram

1. **Nenhum segredo entra no `src/`.** Tudo em `src/` vai para o bundle
   público. Token de API mora no Firestore (lido só pelas Cloud Functions) ou
   em `functions/.env` via `process.env`.
2. `.env`, `functions/.env` e `src/env` ficam fora do git. `src/env` já
   continha um **token real do Asaas** — nunca comitar.
3. **Nunca usar a URL de "unblock secret" do GitHub** para forçar a passagem de
   um segredo bloqueado.
4. **Nunca `git add .`** — sempre nomear os arquivos.
5. **Nunca apagar contato do Mailchimp em definitivo**
   (`/actions/delete-permanent`); arquivar apenas.
6. Canal de QR Code do WhatsApp usa **chip novo dedicado** — nunca o número
   comercial da Datafy, nunca número pessoal.

### Regras do Firestore

Hoje são um curinga:

```
match /{document=**} { allow read, write: if request.auth != null; }
```

Isso já cobre toda coleção nova — não precisa mexer ao criar uma. **Atenção:
regras no Firestore se SOMAM.** Uma regra específica com `allow read: if false`
NÃO cancela o curinga. Para fechar de verdade seria preciso
`request.path[3] != 'colecao'` dentro do próprio curinga — avaliado e adiado,
porque errar ali derruba o sistema inteiro.

---

## 4. Coleções do Firestore

`leads` · `clientes` · `clientes_removidos` · `implantacoes` · `solicitacoes` ·
`usuarios` · `orcamentos` · `contratos` · `contratos_aprovacao` · `campanhas` ·
`campanhas_recorrentes` · `respostas_rapidas` · `gatilhos` · `equipamentos` ·
`orc_servicos` · `orc_templates` · `paginas_campanha` · `paginas_eventos` ·
`base_conhecimento` · `secullum_resolvidos` · `whatsapp_desconhecidos` ·
`whatsapp_status` · `gptmaker_eventos` · `overrides`

Configuração: `config/*` (`sistema`, `contrato`, `orcamento`, `atendimento_ia`,
`exportacao`, `secullum_demo`, `gptmaker`, `smtp`, `treino_historico`),
`config_whatsapp`, `config_etapas_lead`, `config_kanban`, `config_planilhas`,
`config_secreto/gptmaker`.

---

## 5. Integrações

### Datafy — WhatsApp oficial (API da Meta)

Base `https://cloud.datafyapi.com.br`, Bearer token guardado em
`config_whatsapp/{id}`, nunca no navegador.

**REGRA CRÍTICA: os campos de mídia vão SOLTOS no corpo.**

```js
// CERTO                          // ERRADO (formato da Meta)
{ to, url, caption }              { to, image: { link } }
```

Mandar aninhado devolve `400: "url ou media_id é obrigatório"`. O mesmo vale
para o botão CTA (`button_label` e `button_url` soltos). Esse erro já derrubou
silenciosamente o envio de imagem das campanhas por meses.

**Janela de 24 horas da Meta**: só a mensagem de entrada do cliente reabre a
janela. Mensagem nossa não reabre nada.

**Áudio**: OGG/OPUS **mono** + `voice: true` chega como áudio de voz de verdade
(ícone de microfone, ondinha). Outros formatos chegam como arquivo.
`ffmpeg -ac 1 -ar 48000 -c:a libopus`. Vídeo: MP4, 16 MB, H.264 + AAC.

### Asaas — cobrança

Token em `functions/.env` como `ASAAS_KEY`. Tem liga/desliga geral em
Configurações › Integrações.

**Excluir cliente no CRM não cancela nada no Asaas** — a assinatura continua
cobrando. O modal de exclusão avisa isso em vermelho.

### Secullum — conferência de demonstrações

Upload manual do CSV "Serviços Web em Demonstração", cruzado por **CNPJ**.
Economiza ~40 min/semana de conferência.

**Nunca abrir o CSV no Excel antes de subir**: o Excel come o zero da frente do
CNPJ e a conferência erra. Por isso existe `chaveDoc()`, que normaliza os dois
lados devolvendo os zeros pelo comprimento.

### Google Sheets — exportação dos faturados

Via `google-auth-library` com credencial padrão do ambiente, sem chave privada
guardada. **Escreve numa planilha que já existe** — conta de serviço tem cota
ZERO no Drive, então criar arquivo falha.

### GPT Maker — agente de WhatsApp e Instagram

Ver `claude/integracao-gptmaker.md` no projeto. Fase 1 (espião) concluída,
fase 3 (criar lead) pendente.

### SMTP / nodemailer

Configurado em `config/smtp`. Usado no envio de proposta por e-mail e nos
avisos internos.

---

## 6. Armadilhas já descobertas (o mais valioso deste documento)

**Tradução automática do Chrome quebra o React.** Com `<html lang="en">` o
Chrome traduzia a interface: "Leads"→"Pistas", "Ago"→"Atrás", "Set"→"Definir",
"16 fat."→"16 gorduras". Pior: o tradutor troca o texto por baixo do React, e
quando o React vai atualizar aquele nó não acha o que esperava e a tela quebra
— era a causa dos "campos que não abrem". Resolvido com `lang="pt-BR"`,
`translate="no"`, `<meta name="google" content="notranslate"/>` e
`<body class="notranslate">`.

**Número brasileiro com ponto e vírgula.** "1.150,00" é milhar; "69.9" é
decimal. A vírgula é o que distingue: só tirar os pontos quando existe vírgula.
Ignorar isso transformou R$ 69,90 em R$ 699,00.

**Data como texto ordena errado.** "12/08/2026" comparado como string ordena
pelo dia. Converter para `aaaammdd` antes de ordenar.

**Timestamp do Firestore não vai para o Sheets.** Objeto Timestamp estoura
`struct_value`. Normalizar toda célula para primitivo antes de enviar.

**Índice composto do Firestore.** Consulta com igualdade num campo e faixa em
outro exige índice composto. Contornado consultando por um critério só e
filtrando o resto na memória.

**Storage rules casam por número de segmentos.** `match /implantacoes/{id}/{arquivo}`
casa exatamente dois níveis. Para uma pasta com profundidade variável é
`match /config/{allPaths=**}`.

**Documento do Firestore morre em 1 MB.** Por isso imagem vai para o Storage,
não em base64 no documento.

**`recipient` do GPT Maker não é telefone.** No WhatsApp calha de ser; no
Instagram é um IGSID de 15 dígitos. Deduplicar por ele junta pessoas diferentes
no mesmo cadastro.

**Detectar telefone por regex no corpo inteiro dá falso positivo.** Timestamp
de 13 dígitos passa por telefone. Procurar pelo NOME do campo é mais confiável.

**Estilo inline do React vira `rgb()` no atributo.** `style={{background:'#fff'}}`
serializa como `background: rgb(255, 255, 255)`. É isso que permite o modo
escuro por seletor de atributo. Mas `innerHTML` com style em texto puro **não**
é normalizado — por isso o CSS escuro tem também as variantes em hex.

**`top` é global reservado no navegador.** `const top = ...` num script de
página quebra tudo com "Identifier 'top' has already been declared".

**Node 20 nas Functions vence em 30/10/2026.** Precisa atualizar antes.

**Chaves duplicadas em `App.js`** sobrescrevem os padrões de
`pagamentoI` / `parcelasI` / `pagamentoE` / `parcelasE`. Aparece como aviso no
build. Não quebrou nada ainda, mas está errado.

---

## 7. O que já está construído

### Leads e comercial
Funil com etapas configuráveis, filtro que abre em "Sem responsável", importação
da planilha da Meta, páginas de captura com link por campanha, conversas dentro
do CRM, respostas rápidas (texto, imagem, áudio, vídeo, documento, botão de
link, com delays e "digitando..."), campanhas e campanhas recorrentes, copiloto
de sugestão na conversa, selos de canal de origem (📊 planilha, 🤖 agente,
🔗 página, 💬 WhatsApp, ✍️ manual — origem é LISTA, não valor único).

### Orçamento
Montagem a partir do lead, tabela de serviços e equipamentos, piso de venda com
liberação por admin, documento em Word/PDF no modelo aprovado, envio por e-mail
com capa visual e por WhatsApp, Kanban como visão padrão, desfazer venda.
**Desconto derivado do preço de tabela** (mostra "de/por" com o % em destaque) e
**frete com destaque de GRÁTIS** quando não há valor.

### Contrato
Modelo editável em Configurações, Cláusula 1 por plano, **Anexo I com as
características do plano** em página própria, link de aprovação eletrônica com
captura de nome completo e CPF (com dígito verificador), hash do texto aprovado,
registro de IP e de cada abertura. Assinatura eletrônica simples, MP 2.200-2/2001
— **falta a cláusula no modelo dizendo que as partes aceitam esse meio**.

### Clientes
Cadastro completo, ficha imprimível, **exclusão com motivo obrigatório e lixeira
para restaurar**, **trava de CNPJ duplicado** no cadastro novo.

### Secullum
Upload do CSV no topo, cruzamento por CNPJ, abas Pode ativar / Oportunidade /
Em negociação / Sem demonstração / Baixados na mão / **Expirados**, ativar
offline com justificativa.

### Relatórios de impressão
Motor único (`abrirRelatorio`) usado em Secullum, no menu Relatórios e na ficha
do cliente. Abre em janela cheia, com cabeçalho da Guion, totais, o filtro que
gerou a lista e quem imprimiu. Falta ligar em Leads, Orçamentos, Implantação e
Financeiro — é só passar as colunas.

### Atendimento IA (dentro do CRM, separado do GPT Maker)
Em Anúncios › 🤖 Atendimento IA. Responde o cliente sozinho pela Datafy quando
a chave `ativo` está ligada, o telefone casa com um lead existente, ninguém
assumiu, está no horário e não há palavra sensível.

**Pegadinha**: o **modo treino** responde mesmo com o atendimento desligado,
porque a verificação acontece antes no código. E o modo treino vem ligado por
padrão.

### Modo escuro
Botão 🌙 no topo. Funciona por folha de estilo com seletor de atributo, sem
tocar nas 3.600 cores escritas à mão. Preferência no `localStorage` (é do
monitor, não da pessoa). **Tem ajustes pendentes** — ver
`claude/ajustes-modo-escuro.md`.

---

## 8. Como o Andreus gosta de trabalhar

Isto vale tanto quanto a parte técnica.

- **Documento tem que ser visual.** Palavras dele: *"Toda a MD que você for
  criar, cria pra mim de forma visual, eu sou um cara visual. Eu preciso de
  gráficos, de telas, de texto pra mim me atrapalha muito. TDH é forte."*
  Diagrama, número grande, cor, tela desenhada — não parágrafo corrido.
- **Validar antes de construir.** *"Não gere nada ainda, vamos ser cuidadosos
  para não gerar lixo, tudo que temos já funciona, vamos com cuidado."*
- **Acertar na primeira.** *"Valide comigo as ideias, para que a gente possa
  fazer algo que já funcione perfeitamente na tela já na primeira conclusão."*
- **Resposta curta.** Ele percebe e reclama quando a resposta demora.
- Fala por áudio transcrito — às vezes a transcrição corta o "não" do começo da
  frase. Na dúvida, perguntar.
- Prefere cadastrar as coisas na mão a importar. Quer entender o que está indo
  para dentro do sistema.

### Padrão de qualidade que o projeto adota

- Nada é apagado de verdade: exclusão vai para uma coleção de removidos, com
  motivo, autor e data, e dá para restaurar.
- Toda ação destrutiva pede justificativa escrita.
- Transcrição de áudio **sempre no fim**, carimbada com data, hora e usuário —
  nunca por cima do que já estava lá.
- Comentário no código explica **por que**, não o que. De preferência contando
  o erro que aquilo evita.
- Testar antes de entregar: renderizar o documento, rodar o cálculo, simular a
  tela no navegador.

---

## 9. Pendências

**Do GPT Maker** (detalhe em `claude/integracao-gptmaker.md`)
1. Fase 3 — criar o lead a partir do evento, com dedupe por canal + id.
2. Ensinar o agente a pedir o telefone quando vier do Instagram.
3. Conferir se o Atendimento IA do CRM está no mesmo número do agente — dois
   robôs respondendo o mesmo cliente.

**Do sistema**
4. Ajustes do modo escuro, com o **bug das linhas zebradas ilegíveis** em
   primeiro lugar (`claude/ajustes-modo-escuro.md`).
5. Botão de relatório nos menus que faltam.
6. Cláusula de aceite eletrônico no modelo de contrato — texto para o advogado.
7. Domínio próprio para as páginas de captura
   (`ponto.guioninformatica.com.br`), porque a URL do Storage com token não
   serve para anúncio.
8. Investigar os **8 leads da Meta de 13 e 14/08** que nunca chegaram no CRM
   apesar da sincronização de 5 minutos.
9. Campos `empresa` e `instagram` no lead.
10. Plano "Saúde dos clientes" — agente de pós-venda
    (`claude/plano-saude-clientes.md`).
11. Segunda página institucional do orçamento tem a especificação do EVO Facil
    40 fixa no código.
12. Corrigir as chaves duplicadas em `App.js`.
13. Atualizar o Node antes de 30/10/2026.

**Em aberto na conversa**
14. Página de depoimento em vídeo — três perguntas, aviso "grave naturalmente,
    nossa equipe edita", vídeo de exemplo de 1min30. Falta confirmar se é isso
    mesmo e onde fica.

---

## 10. Documentos do projeto

`claude/integracao-gptmaker.md` — arquitetura e payload real do agente
`claude/ajustes-modo-escuro.md` — paleta e o bug das zebras
`claude/fluxo-orcamento-lead.md` — fluxo do orçamento
`claude/integracao-datafy-midia.md` — regra dos campos soltos
`claude/plano-saude-clientes.md` — agente de pós-venda
`claude/plano-paginas-captura.md` — páginas de campanha
`claude/padrao-de-entrega.md` · `claude/skill-dev-sistemas-gestao.md`
`claude/sistema-controle-manutencao.md` · `claude/sistema-agenda-visitas-tecnicas.md`
`claude/sistema-controle-pedidos.md`
