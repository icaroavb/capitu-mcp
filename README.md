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
git clone <url-do-repo> capitu-mcp
cd capitu-mcp
.\install.ps1
```

O instalador pergunta dados SAP, salva credenciais como variáveis Windows persistentes, gera `.mcp.json` e roda `npm install`. Detalhes em [SETUP.md](SETUP.md).

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
tools existem com os prefixos `capituDocs*`, `capituDev*` e `capituSpec*`.

> **Compatibilidade:** sem `instances.json`, o capitu usa as env vars `SAP_*`
> como uma instância implícita chamada `env` — tudo que já funcionava continua
> funcionando.

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
