# Arquitetura do Capitu

> Ecossistema de MCPs SAP cooperativos com Knowledge Base compartilhada e aprendizado contínuo.

## 1. Visão

Capitu é um ecossistema de **3 servidores MCP especializados** (não um MCP monolítico) que cooperam através de uma **Knowledge Base SQLite compartilhada** com aprendizado contínuo, projetado para **S/4HANA Cloud Private Edition (PCE)** acessado via ADT.

Os três agentes:

- **capitu-docs** — RAG sobre documentação SAP (ABAP keyword, Help Portal, Community) + catálogo dinâmico do tenant (released APIs, OData services).
- **capitu-dev** — Desenvolvimento e debug via ADT REST API. Lê código, escreve com gates de segurança, roda ATC e ABAP Unit.
- **capitu-spec** — Tradução de requisitos em linguagem natural para especificação técnica SAP (qual CDS view, qual BDEF, qual service binding).

## 2. Diferenciação vs concorrentes existentes

O mercado MCP SAP em 2026 tem ~10 projetos relevantes. A análise comparativa identificou 4 gaps que **nenhum concorrente preenche**:

| Gap | ARC-1 | vsp | mcp-sap-docs | Capitu |
|-----|-------|-----|--------------|--------|
| Multi-MCP cooperativo | ❌ | ❌ | ❌ | ✅ |
| Aprendizado contínuo (KB cresce com uso) | ❌ | ❌ | ❌ | ✅ |
| PCE como cidadão de primeira classe | parcial | ❌ | N/A | ✅ |
| Debug + RAG juntos | ❌ | só debug | só RAG | ✅ |

**Princípio de diferenciação vs mcp-sap-docs** (concorrente direto, 176 stars):
> Não competimos em **largura** de fontes documentais. Competimos em **profundidade PCE-specific** e em **integração com o agente de dev**, alimentando a KB com aprendizados do próprio tenant.

## 3. Stack

| Camada | Escolha | Razão |
|--------|---------|-------|
| Linguagem | TypeScript 5+ / Node ≥22 | Ecossistema MCP mais maduro, SDK Anthropic oficial |
| MCP SDK | `@modelcontextprotocol/sdk` | Oficial Anthropic |
| Cliente ADT | `abap-adt-api` (Marcello Urbani) | Wrapper consolidado, CSRF/cookies tratados |
| KB | SQLite + `sqlite-vec` + FTS5 | Local, sem servidor externo, hybrid search nativo |
| Embeddings | Voyage `voyage-3-lite` (512 dims) | Anthropic-friendly, $0.02/M tokens |
| Busca | BM25 (FTS5) + vector + RRF | Padrão validado pelo mcp-sap-docs |
| Testes | vitest | Padrão usado pelo ARC-1 |
| Lint | biome | Idem |

### Decisões rejeitadas e por quê

- **Go (como vsp):** overkill para o escopo, ecossistema MCP menor, sem ganho de performance percebido para nosso caso.
- **Python:** brilha em data/OData mas não no ADT (que é XML over HTTP). Sem ganho.
- **Embeddings locais (Ollama):** custo zero recorrente é atraente, mas qualidade inferior + setup mais complexo. Voyage-3-lite custa centavos por mês para uso pessoal.
- **Postgres + pgvector:** infraestrutura adicional sem benefício para uso single-user. SQLite + sqlite-vec roda no mesmo processo.
- **MCP monolítico:** perde modularidade e aprendizado isolado por agente. Vai contra o gap principal que estamos atacando.

## 4. Arquitetura do ecossistema

```
┌─────────────────────────────────────────────────────────┐
│                  CAPITU (3 MCPs cooperativos)           │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│  │ capitu-  │    │ capitu-  │    │ capitu-  │         │
│  │  spec    │◄──►│  dev     │◄──►│  docs    │         │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘         │
│       │               │               │                 │
│       └───────────────┴───────────────┘                │
│                       │                                 │
│            ┌──────────▼──────────┐                     │
│            │   Capitu KB         │                     │
│            │  (SQLite + vec)     │                     │
│            └─────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
            S/4HANA Cloud PCE (ADT REST)
```

### Como os três cooperam

- Cliente MCP (Claude/Cursor) conecta nos três servidores simultaneamente.
- Cada agente expõe **suas próprias tools** com prefixos claros (`capituSpec*`, `capituDev*`, `capituDocs*`).
- O **LLM cliente** decide a cada turno qual ferramenta usar — não há roteador central.
- Os três compartilham a **mesma KB** (mesmo arquivo SQLite), com tabelas isoladas por concern.
- O **aprendizado contínuo** acontece quando `capitu-dev` resolve um problema e grava em `learnings`; nas próximas sessões, `capitu-docs` recupera esse aprendizado como contexto.

## 5. Knowledge Base compartilhada — schema

A KB vive em `~/.capitu/kb.db` (ou path configurável via `CAPITU_KB_PATH`). Quatro grupos de tabelas:

### 5.1 Docs SAP indexadas (estático, re-indexado periodicamente)

```sql
CREATE TABLE docs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,         -- 'abap-keyword', 'help-portal', 'community'
  release TEXT,                 -- '7.58', 'cloud', alinhado ao release do tenant
  url TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_meta TEXT,              -- JSON: parent_url, section, language
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE docs_fts USING fts5(content, content=docs, content_rowid=id);
CREATE VIRTUAL TABLE docs_vec USING vec0(embedding float[512]);
```

### 5.2 Aprendizados do tenant (dinâmico — diferencial principal)

```sql
CREATE TABLE learnings (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,           -- 'error-fix', 'pattern', 'decision', 'gotcha'
  context TEXT,                 -- JSON: object_uri, release, package
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  validated_at TIMESTAMP,       -- null = ainda não confirmado pelo usuário
  source_agent TEXT,            -- 'capitu-dev', 'capitu-spec', 'capitu-docs'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[512]);
```

### 5.3 Catálogos do tenant (descoberta dinâmica via ADT)

```sql
CREATE TABLE tenant_catalog (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,           -- 'released_api', 'odata_service', 'cds_view'
  name TEXT NOT NULL,
  release_contract TEXT,        -- C0/C1/C2/C3
  metadata TEXT,                -- JSON
  refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type, name)
);
```

### 5.4 Traces (histórico para curador automático)

```sql
CREATE TABLE traces (
  id INTEGER PRIMARY KEY,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT,                   -- JSON
  output TEXT,                  -- JSON (truncated se grande)
  duration_ms INTEGER,
  status TEXT                   -- 'ok', 'error'
);
```

## 6. Busca híbrida (RRF)

Receita validada pelo `mcp-sap-docs`:

1. Executar BM25 via FTS5 → top 20 resultados ranqueados.
2. Executar busca vetorial via `sqlite-vec` → top 20 resultados ranqueados.
3. Aplicar **Reciprocal Rank Fusion**: `score(doc) = Σ 1/(k + rank_i)`, k=60.
4. Retornar top N do score combinado.

## 7. Roadmap

| Fase | Foco | Entrega |
|------|------|---------|
| 0 | Setup monorepo + KB lib | `packages/kb` funcional, schema criado, tests |
| 1 | capitu-docs MVP | Ingestão ABAP keyword (release do tenant) + tool `search` |
| 2 | capitu-docs enriquecido | Released APIs do tenant + community blogs + aprendizado contínuo |
| 3 | capitu-dev MVP | Read tools via `abap-adt-api`, consulta `capitu-docs` |
| 4 | capitu-dev write | Edição method-level, safety gates, capability matrix |
| 5 | capitu-spec MVP | Tradução natural→spec, lê learnings + tenant catalog |

## 8. Compliance com SAP API Policy (abril 2026)

A SAP publicou em abril de 2026 a **API Policy** ([FAQ oficial](https://www.sap.com/documents/2026/04/e2a0665e-4c7f-0010-bca6-c68f7e60039b.html)). A Questão 33 trata especificamente de **ADT e developer tooling**, e define o que é "endossado" vs "fora de escopo":

**Endossado via ADT (verde):**
- Code authoring (leitura e escrita de objetos ABAP)
- Code checks (ATC, syntax check)
- Build processes
- Transport management
- abapGit
- Debug do próprio código customizado
- ABAP Unit
- Utilitários customizados sobre Eclipse Java SDK documentado

**Fora de escopo via ADT (cinza, proibido para integração agentic):**
- Leitura programática de tabelas de aplicação
- Execução de SQL contra backend
- Integração de dados de negócio
- Orquestração em runtime
- Workflows de AI agêntica operando sobre dados de negócio
- Substituição de business APIs

### Dois modos de operação

Capitu implementa dois modos explícitos, com gate central em `@capitu/kb/compliance`:

| Modo | Env var | Comportamento |
|------|---------|---------------|
| **strict** (default) | `CAPITU_COMPLIANCE_MODE=strict` (ou ausente) | Apenas categorias endossadas. Tools fora de escopo retornam erro semântico citando a política. |
| **permissive** | `CAPITU_COMPLIANCE_MODE=permissive` + `CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes` | Habilita tools "cinza" com warning explícito por chamada e registro no audit log (`traces`). Duplo opt-in obrigatório. |

Cada tool ADT declara sua `ToolCategory` (ver `packages/kb/src/compliance.ts`) e chama `assertAllowed(category, ctx)` antes de executar. Isso garante que:

1. O comportamento default é alinhado com a política oficial
2. O bypass é explícito, auditado e requer dois opt-ins separados
3. O LLM cliente recebe uma mensagem semântica quando uma tool é negada, em vez de erro genérico

### Princípio editorial

O capitu **se posiciona como developer tooling**, não como agentic data layer. Toda nova tool deve ser modelada primeiro na categoria endossada; só se cair em zona cinza é que entra no fluxo permissive. Isso protege o usuário e mantém o projeto utilizável em ambientes corporativos.

## 9. Segurança e safety

Princípios herdados do ARC-1 (validados em produção):

- **Read-only por padrão.** Escrita exige opt-in explícito (`CAPITU_ALLOW_WRITES=true`).
- **Package allowlist** para writes (`CAPITU_ALLOWED_PACKAGES="Z*,Y*"`). Sem allowlist, só `$TMP`.
- **Capability matrix por release contract:** antes de qualquer write, consulta o contract C0/C1/C2/C3 do objeto e recusa se incompatível com o projeto, retornando mensagem semântica em vez de 403 cru.
- **Audit log estruturado** em `traces` da KB — toda operação é registrada.
- **Sem credenciais em código.** Service Key file ou env vars apenas.

## 10. PCE como cidadão de primeira classe

Decisões específicas para S/4HANA Cloud Private Edition:

- **Auth padrão:** Communication Arrangements + Service Key (não Basic auth).
- **URL pattern:** validamos `<sid>.<region>.s4hana.cloud.sap` na conexão.
- **Released APIs:** ao conectar, indexa o catálogo de released objects do tenant via `CL_ABAP_RELEASED_API`.
- **OData V4 catalog:** descoberto via `/sap/opu/odata/IWFND/CATALOGSERVICE` e indexado em `tenant_catalog`.
- **Release-aware:** o release exato do tenant (ex: S/4HANA 2023 FPS01) é descoberto e usado para indexar ABAP keyword docs da versão correta — não `latest`.

## 11. Multi-instância dinâmica

Consultores trabalham com vários sistemas. Em vez de uma conexão fixa lida no boot, o capitu resolve a instância **ativa** em runtime e permite trocá-la sem reiniciar.

**Mecânica:**

- `ServerContext.adt` não é mais um campo fixo — é um **getter** que delega a um `InstanceRegistry` (`packages/adt-client/src/instance-registry.ts`). As ~38 tools continuam chamando `ctx.adt.*` sem alteração; o cliente subjacente é resolvido por baixo.
- Os perfis vêm de `~/.capitu/instances.json` (`CAPITU_INSTANCES_PATH`), carregados por `loadInstanceProfiles` (`packages/kb/src/instances.ts`). Sem o arquivo, há fallback para uma instância `env` sintetizada das env vars `SAP_*` — retrocompatível.
- O ponteiro de **instância ativa** vive na tabela `meta` (key `active_instance`) do SQLite compartilhado. Como os 3 servidores são processos `stdio` **separados**, a KB é o único canal entre eles: uma troca feita no `capitu-dev` é observada por `docs`/`spec` na **próxima** chamada de tool deles. Resultado: visão de instância única e coerente no ecossistema.
- O `InstanceRegistry` cacheia um `CapituAdtClient` por instância (lazy); ao detectar que o ativo mudou (inclusive out-of-band, por outro processo), desconecta o anterior best-effort e devolve o novo.

**Segurança:** senhas nunca ficam no `instances.json`. Cada perfil referencia `passwordEnv` (nome de uma env var); o registry só resolve a senha no momento de construir o cliente, e o `list()` jamais expõe segredos.

**Tools** (`metadata-read`, endorsed): `capitu{Dev,Docs,Spec}ListInstances`, `…WhichInstance`, `…UseInstance({name, probe})`. O `UseInstance` faz um `probeEnvironment` opcional para confirmar edition/release do alvo. Toda troca entra no audit `traces` via `withTrace`.

**Direção de dependência preservada:** o `InstanceRegistry` (em `adt-client`) recebe a persistência por callbacks (`getActive`/`setActive`/`resolvePassword`/`resolveCookie`/`resolveBearer`), então `adt-client` não passa a depender de `@capitu/kb` — o wiring acontece no `context.ts` de cada MCP, que já importa ambos.

### 11.1 Capacidades por instância (inspiradas em ARC-1 + vsp)

Cada `InstanceProfile` carrega configuração que o código existente lê do **perfil ativo** em vez de uma fonte global:

- **Safety por instância (ceiling).** `readOnly` + `allowedPackages` no perfil. `ctx.writes` virou getter = **interseção** do teto env (`CAPITU_ALLOW_WRITES`/`CAPITU_ALLOWED_PACKAGES`) com o perfil ativo (`computeWriteGate` em `context.ts`). Um perfil só restringe. **Default restritivo:** perfil sem `readOnly` declarado → writes bloqueados (`restrictedByDefault`), e `assertWritesEnabled` (canônico em `context.ts`, usado pelos 3 write tools) emite mensagem explicando o modo + passo-a-passo de opt-in. Modelo do `read_only`/`allowed_packages` por sistema do vsp (`pkg/config/systems.go`).
- **Feature probing.** `probeFeatures` (`packages/adt-client/src/features.ts`) faz GET leve em ~6 endpoints e classifica o status HTTP (2xx/400/405/5xx→disponível; 401→indeterminado; 403→sem-autz; 404→ICF-off). Chamado no `useInstance`; resultado vai pro `tenant_catalog` (`type:'feature'`, `name:"<instância>:<feature>"`). Lógica nossa, ideia do `features.ts` do ARC-1.
- **Auth cookie/bearer.** `authMode` no perfil (`basic`|`cookie`|`bearer`). `buildInner` em `client.ts` monta o `ADTClient`: bearer usa o `BearerFetcher` que a lib aceita no slot de senha; cookie injeta o header `Cookie` via `ClientOptions.headers` (com placeholder de senha, pois a lib rejeita senha vazia na construção). Segredos nunca no arquivo (`cookieFile`/`bearerEnv`).
- **Tool visibility.** Mapa `tools` na raiz do `instances.json` (`{nome: bool}`). O `ListTools`/dispatch dos 3 `server.ts` filtra por `isToolEnabled`; as tools de instância são imunes (senão o usuário se tranca fora). Espelha `SystemsConfig.Tools` do vsp.

> **Contexto competitivo:** a SAP lançou (jun/2026) a extensão oficial *ADT for VS Code* com MCP próprio (Joule, cloud-first, pago, sem AI de terceiros). O nicho do capitu — PCE, multi-modelo (Claude), sem licença paga, aprendizado contínuo, multi-instância consultiva — fica reforçado. Integração com essa extensão é um follow-up em aberto.
