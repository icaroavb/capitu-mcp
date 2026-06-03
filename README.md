# capitu-mcp

Ecossistema de **3 MCPs SAP cooperativos** com Knowledge Base compartilhada e aprendizado contínuo, projetado para **S/4HANA Cloud Private Edition (PCE)**.

```
┌──────────────┐  ┌─────────────┐  ┌──────────────┐
│ capitu-spec  │  │ capitu-dev  │  │ capitu-docs  │
│ (spec téc.)  │  │ (ADT + dbg) │  │ (RAG SAP)    │
└──────┬───────┘  └──────┬──────┘  └──────┬───────┘
       └──────────┬──────┴────────────────┘
                  ▼
            ┌──────────┐
            │   KB     │  SQLite + sqlite-vec
            │ shared   │  (docs / learnings / tenant / traces)
            └──────────┘
                  │
                  ▼
            S/4HANA Cloud PCE (ADT REST)
```

## Antes de começar — você vai precisar de

O capitu é um conjunto de **servidores MCP**: ele dá superpoderes SAP a um
assistente de IA (Claude). Ele **não é** um app standalone — roda *dentro* de um
cliente MCP. Então, antes de instalar, garanta os três pré-requisitos:

| # | Pré-requisito | Como obter / verificar |
|---|---------------|------------------------|
| 1 | **Node.js 22+** | `winget install OpenJS.NodeJS.LTS` · verifique com `node --version` |
| 2 | **Claude Code CLI + conta Anthropic** | Instale de [code.claude.com](https://code.claude.com); precisa de uma assinatura ativa. Verifique com `claude --version`. (É o `claude` que carrega o capitu.) |
| 3 | **Acesso a um SAP com ADT habilitado** | URL do sistema, usuário, senha e mandante. Qualquer S/4HANA moderno onde você tenha permissão de desenvolvedor. Se você usa o Eclipse com ADT, já tem isso. |

> Sem os três, o capitu não tem como funcionar. O item 2 é o mais esquecido:
> o passo final do setup é abrir o `claude`, que **precisa estar instalado**.

> 🪟 **Plataforma:** o instalador (`install.ps1`) é **Windows / PowerShell**.
> Em Mac/Linux, siga o "Modo manual" em [SETUP.md](SETUP.md) (mesmos passos, à mão).

## Estrutura

```
capitu-mcp/
├── packages/
│   ├── kb/          # Knowledge Base compartilhada (SQLite + vec + FTS5)
│   ├── adt-client/  # Wrapper sobre abap-adt-api
│   ├── docs-mcp/    # capitu-docs — RAG sobre docs SAP + learnings
│   ├── dev-mcp/     # capitu-dev — CRUD ABAP, write atômico, transports
│   └── spec-mcp/    # capitu-spec — propose/apply de specs RAP
├── install.ps1      # Instalador interativo (Windows)
├── SETUP.md         # Guia de configuração
├── ARCHITECTURE.md  # Design e decisões
└── README.md
```

## Setup rápido

```powershell
git clone https://github.com/icaroavb/capitu-mcp.git
cd capitu-mcp
.\install.ps1
```

O instalador checa os pré-requisitos, pergunta os dados SAP, salva a senha como
variável Windows persistente (nunca em arquivo), gera o `.mcp.json` e roda
`npm install`. Detalhes em [SETUP.md](SETUP.md).

## Primeiro uso (importante)

Depois do `install.ps1`:

```powershell
# 1. Abra um PowerShell NOVO (para herdar as variáveis de ambiente salvas)
# 2. Entre na pasta do projeto — o claude SÓ carrega o capitu se aberto AQUI:
cd caminho\para\capitu-mcp
# 3. Abra o Claude Code:
claude
```

No Claude Code:

1. Rode `/mcp` — os três servidores (`capitu-docs`, `capitu-dev`, `capitu-spec`)
   devem aparecer como **✓ connected**.
2. Teste com um comando read-only, por exemplo:
   *"use o capituDevSearch para listar objetos ZI_* do tipo DDLS"*.

> ⚠️ **Gotcha nº 1:** o `claude` precisa ser aberto **de dentro da pasta do
> projeto** (onde está o `.mcp.json`). Aberto em outro diretório, os servidores
> capitu não aparecem no `/mcp` — e parece que "não funcionou".

> 🔒 Por padrão o capitu **não escreve** no SAP (read-only). Habilitar escrita é
> opt-in explícito — veja "Segurança por instância" abaixo.

## Comandos comuns

```powershell
npm test          # unit tests
npm run typecheck # TS compilation
claude            # abre o Claude Code com os 3 MCPs carregados
```

## Variáveis de ambiente

| Var | Default | Descrição |
|-----|---------|-----------|
| `SAP_URL` | — | URL ADT do tenant. Obrigatório **só** no modo instância-única (sem `instances.json`) |
| `SAP_USER` | — | Usuário SAP. Idem acima |
| `SAP_PASSWORD` | — | Senha SAP (env var, nunca em arquivo). Usada por instâncias que não definem `passwordEnv` próprio |
| `SAP_CLIENT` | — | Mandant (para sistemas multi-client) |
| `SAP_LANGUAGE` | — | Idioma de logon (ex: PT, EN) — deve bater com o idioma original do sistema |
| `CAPITU_INSTANCES_PATH` | `~/.capitu/instances.json` | Arquivo de perfis para uso multi-instância (ver seção abaixo) |
| `CAPITU_KB_PATH` | `~/.capitu/kb.db` | Caminho do SQLite compartilhado |
| `CAPITU_OUTPUT_DIR` | `<projeto>/capitu-output/` | Pasta onde `.docx` gerados são salvos |
| `CAPITU_ALLOW_WRITES` | `false` | Habilita writes ADT no capitu-dev |
| `CAPITU_ALLOWED_PACKAGES` | `$TMP` | Allowlist de pacotes para writes |
| `CAPITU_COMPLIANCE_MODE` | `strict` | `strict` ou `permissive` — gate da SAP API Policy (Q33) |
| `CAPITU_I_UNDERSTAND_API_POLICY_RISK` | — | Deve ser `yes` em permissive mode para habilitar tools "cinza" |
| `CAPITU_EMBEDDINGS` | `bm25` | `bm25` (sem custo), `voyage` ou `local` |
| `VOYAGE_API_KEY` | — | Necessária quando `CAPITU_EMBEDDINGS=voyage` |

## Rodando sem custo (modo BM25-only)

Se você quer rodar o capitu **sem nenhuma API paga e sem download de modelo ML**, use o modo BM25-only:

```powershell
$env:CAPITU_EMBEDDINGS = "bm25"
```

Nesse modo:
- ✅ Todas as tools continuam funcionando (read, write, create, activate, transport, document)
- ✅ Learnings continuam sendo gravados e recuperáveis por palavra-chave
- ✅ `capituDocsSearch` faz busca por palavras-chave (FTS5) sobre as docs indexadas
- ❌ Busca semântica desativada — palavras precisam coincidir literalmente
- ❌ Recall de learnings é menos esperto (LIKE em vez de similaridade)

**Quando vale a pena:**
- Rede corporativa bloqueia HuggingFace e/ou Voyage AI
- Você quer compartilhar o projeto sem que outros precisem de conta paga
- Está fazendo experimentos rápidos sem se importar com qualidade semântica

**Para ativar embeddings reais depois,** basta:
1. Apagar o KB existente: `Remove-Item "$env:USERPROFILE\.capitu\kb.db*"`
2. Setar `VOYAGE_API_KEY` ou `CAPITU_EMBEDDINGS=local`
3. Reabrir o Claude Code

## Múltiplas instâncias (uso consultivo)

Se você trabalha com **vários sistemas SAP** (clientes/landscapes), pode trocar a
instância ativa **em runtime**, sem editar `.mcp.json` nem reabrir o Claude Code.

1. Crie `~/.capitu/instances.json` a partir de [`instances.example.json`](instances.example.json).
   Cada instância tem um `name`, a `url`, o `user`, e `passwordEnv` — o **nome** da
   variável de ambiente que guarda a senha (a senha **nunca** vai no arquivo).
2. Salve uma env var de senha por instância (escopo User, persistente):
   ```powershell
   [Environment]::SetEnvironmentVariable("SAP_PASSWORD_CLIENTEX", "<senha>", "User")
   ```
3. No Claude Code:
   - *"liste as instâncias"* → `capituDevListInstances`
   - *"conecta no cliente Y"* → `capituDevUseInstance` (faz um probe e confirma edition/release)
   - *"onde estou conectado?"* → `capituDevWhichInstance`

A troca vale para os **três** MCPs ao mesmo tempo (docs/dev/spec compartilham o
estado pela KB), então uma única troca move a visão do ecossistema inteiro. As
tools existem com os prefixos `capituDocs*`, `capituDev*` e `capituSpec*`. Ao
trocar, o `useInstance` também **sonda as capacidades** do sistema (RAP, abapGit,
transport, AMDP, UI5, HANA) e mostra o que está disponível — você planeja em vez
de tentar-e-falhar.

### Segurança por instância (ceiling)

Cada instância pode ter seu próprio gate de escrita, **mais restritivo** que o
teto global (`CAPITU_ALLOW_WRITES`/`CAPITU_ALLOWED_PACKAGES`) — um perfil só
aperta, nunca afrouxa:

```jsonc
{ "name": "dev",  "readOnly": false, "allowedPackages": ["$TMP", "Z*"] },  // escrita liberada (limitada)
{ "name": "prod" }                                                          // sem readOnly → READ-ONLY por padrão
```

> ⚠️ **Default seguro:** uma instância que **não** declara `"readOnly": false`
> fica **read-only**, mesmo com `CAPITU_ALLOW_WRITES=true`. Ao tentar escrever,
> o capitu explica que está em modo restritivo e dá o passo-a-passo para liberar
> (editar o perfil + `capituDevUseInstance` de novo — sem reiniciar).

`allowedPackages` aceita: nome exato (`ZFOO`), prefixo (`Z*`), e **subárvore**
`ZFOO/**` — o pacote `ZFOO` e todos os sub-pacotes dele (resolve a hierarquia
real via ADT, com cache). A resolução é **fail-closed**: se a hierarquia não
puder ser consultada, o write é negado por segurança.

### Autenticação alternativa (cookie / bearer)

Além de senha (`basic`), uma instância pode usar SSO por cookie ou OAuth:

```jsonc
{ "name": "sso", "authMode": "cookie", "cookieFile": "<HOME>/.capitu/cookies.txt" },
{ "name": "btp", "authMode": "bearer", "bearerEnv": "BTP_BEARER_TOKEN" }
```

Cookies/tokens **nunca** ficam no arquivo — `cookieFile` aponta para um arquivo
local, `bearerEnv` nomeia uma env var.

### Visibilidade de tools

O `instances.json` aceita um mapa `tools` na raiz para desligar ferramentas
(`{ "capituDevSearch": false }`). Tool não listada fica habilitada; as tools de
instância nunca podem ser desligadas.

> **Compatibilidade:** sem `instances.json`, o capitu usa as env vars `SAP_*`
> como uma instância implícita chamada `env` — tudo que já funcionava continua
> funcionando.

## Coexistência com a extensão oficial SAP ADT for VS Code

Em jun/2026 a SAP lançou a extensão oficial **ABAP Development Tools for VS Code**,
que inclui um **ADT MCP server próprio** (14 tools `abap_*` em `localhost:2236`,
parte do *Joule for Developers* — cloud-first, licença paga, sem AI de terceiros).

O capitu **coexiste** com ela, não compete:

- **Nomes não colidem:** tools da SAP são `abap_*`; as do capitu são `capitu*`.
  Você pode habilitar os dois MCPs no mesmo cliente.
- **Divisão de trabalho:** a SAP cobre skills Joule em sistemas cloud/RISE; o capitu
  cobre **PCE/on-premise**, **safety controls por instância** (que o MCP da SAP não
  tem), **transport**, **multi-modelo** (Claude/Cursor/qualquer cliente MCP, sem Joule)
  e **aprendizado contínuo** + **multi-instância**.

Para usar o capitu no VS Code, aponte um `.vscode/mcp.json` (ou as settings de MCP do
seu cliente) para os 3 servidores — o mesmo comando `npx tsx .../server.ts` do
`.mcp.json` do Claude Code. Detalhes de posicionamento em [ARCHITECTURE.md §12](ARCHITECTURE.md).

## Busca e cirurgia de código

- **`capituDevGrep`** — busca **regex dentro do código-fonte** de um objeto e retorna
  só as linhas que casam + contexto (não o fonte inteiro). É o padrão "grep para achar
  a linha, depois leia em volta" — econômico em tokens. Case-insensitive, com fallback
  literal (se você esquecer de escapar `read_entities(`, funciona mesmo assim).

## Compliance com SAP API Policy

A SAP publicou em abril/2026 a [API Policy](https://www.sap.com/documents/2026/04/e2a0665e-4c7f-0010-bca6-c68f7e60039b.html). A **Questão 33** define o que é endossado via ADT (dev tooling) e o que está fora de escopo (leitura de dados de negócio, SQL livre, AI agêntica sobre dados de negócio).

Capitu opera em **dois modos**:

- **strict (default):** somente categorias endossadas — autoria de código, ATC, ABAP Unit, transports, abapGit, debug. Alinhado com a política. Use em ambientes corporativos.
- **permissive:** habilita tools "cinza" (leitura de tabelas, SQL livre) com warnings explícitos e audit trail. Requer **duplo opt-in** (`CAPITU_COMPLIANCE_MODE=permissive` + `CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes`). Use em sandbox pessoal, sob sua responsabilidade.

Detalhes em [ARCHITECTURE.md §8](ARCHITECTURE.md).

## Diferenciação

Gaps que **nenhum** dos ~10 concorrentes MCP SAP em 2026 preenche, e que o capitu ataca:

1. **Multi-MCP cooperativo** — três servidores especializados em vez de um monolito
2. **Aprendizado contínuo** — KB cresce com uso, captura padrões do tenant
3. **PCE como cidadão de primeira classe** — release contracts C0/C1/C2/C3, service keys, OData catalog do tenant
4. **Debug + RAG juntos** — combinação que nenhum dos top-3 (ARC-1, vsp, mcp-sap-docs) oferece

## Comparação rápida com concorrentes

| Projeto | Stack | Foco | Stars |
|---------|-------|------|-------|
| ARC-1 | TS | Enterprise + BTP/XSUAA | 78 |
| vsp | Go | Debug + análise nativa | 340 |
| mcp-sap-docs | TS | RAG SAP (largura) | 176 |
| **capitu** | **TS** | **Multi-agente + PCE + aprendizado** | **0 (novo)** |

## Roadmap

| Fase | Foco | Status |
|------|------|--------|
| 0 | Setup monorepo + KB lib | ✅ |
| 1 | capitu-docs MVP (ABAP keyword ingest + search) | ✅ |
| 2 | capitu-docs enriquecido (released APIs + aprendizado) | ✅ |
| 3 | capitu-dev MVP (read via ADT) | ✅ |
| 4 | capitu-dev write (safety gates + capability matrix) | ✅ |
| 5 | capitu-spec MVP (draft→propose→apply, export .docx) | ✅ |
| 6 | Stack RAP completo (BDEF/SRVD/SRVB + publish OData), edição method-level, resilience | ✅ |
| 7 | Multi-instância dinâmica (perfis + `useInstance`) | ✅ |
| — | Próximos: auth `service-key`, curador automático de learnings | ⏳ |

> **Estado atual:** ~38 tools em 3 servidores cooperativos, 223 testes verdes.
