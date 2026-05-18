# @capitu/docs-mcp

Primeiro MCP server do ecossistema capitu. Expõe tools de **busca, aprendizado contínuo e contexto do tenant SAP** via stdio.

## Tools expostas

| Tool | Categoria compliance | Descrição |
|------|---------------------|-----------|
| `capituDocsSearch` | docs-read | Busca híbrida (BM25 + vetor) sobre docs SAP indexadas na KB |
| `capituDocsLearn` | docs-read | Registra um aprendizado (problema → solução) no KB |
| `capituDocsRecallLearnings` | docs-read | Busca aprendizados similares por similaridade vetorial |
| `capituDocsValidateLearning` | docs-read | Marca um aprendizado como confirmado pelo usuário |
| `capituDocsTenantContext` | metadata-read | Probe + listagem de pacotes + busca no tenant SAP conectado |

Todas as tools são da categoria **endorsed** sob a SAP API Policy Q33 — funcionam em `strict` mode sem precisar de opt-in.

## Variáveis de ambiente

| Var | Obrigatório | Descrição |
|-----|------------|-----------|
| `SAP_URL` | sim | URL ADT do tenant (e.g. https://host:8100) |
| `SAP_USER` | sim | Usuário ADT |
| `SAP_PASSWORD` | sim | Senha |
| `SAP_CLIENT` | não | Mandant (e.g. 250) |
| `CAPITU_KB_PATH` | não | Path do SQLite. Default: `~/.capitu/kb.db` |
| `CAPITU_COMPLIANCE_MODE` | não | `strict` (default) ou `permissive` |

Embeddings rodam **localmente via Transformers.js** (`Xenova/all-MiniLM-L6-v2`, 384 dims).

> ⚠️ **Antes do primeiro uso**, rode `npm run warmup:embeddings` na raiz do monorepo. Isso baixa o modelo (~90 MB) para o cache local. Sem o warmup, a primeira chamada às tools `learn` ou `recallLearnings` dentro do MCP pode falhar com `fetch failed` por causa do timeout do MCP (60s) contra a latência de download.

## Rodar localmente

```powershell
# Define credenciais SAP
$env:SAP_URL = "https://<seu-tenant-sap>:<porta>"
$env:SAP_USER = "<seu-usuario>"
$env:SAP_CLIENT = "<mandant>"
$secure = Read-Host -AsSecureString "Senha SAP"
$env:SAP_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password

# Rodar o server (modo desenvolvimento)
npm --workspace @capitu/docs-mcp run start
```

Saída esperada em stderr:
```
[capitu-docs] v0.0.1 ready (5 tools)
```

## Conectar ao Claude Code

Edite `~/.claude.json` (ou `%USERPROFILE%\.claude.json` no Windows) e adicione:

```json
{
  "mcpServers": {
    "capitu-docs": {
      "command": "npx",
      "args": [
        "tsx",
        "<CAMINHO_ABSOLUTO_DO_PROJETO>/packages/docs-mcp/src/server.ts"
      ],
      "env": {
        "SAP_URL": "https://<seu-tenant-sap>:<porta>",
        "SAP_USER": "<seu-usuario>",
        "SAP_CLIENT": "<mandant>",
        "SAP_PASSWORD": "${env:SAP_PASSWORD}",
        "CAPITU_KB_PATH": "<HOME>/.capitu/kb.db"
      }
    }
  }
}
```

> ⚠️ **Nunca** coloque a senha direto no JSON. Use `${env:SAP_PASSWORD}` e defina a env var no terminal antes de abrir o Claude Code.

Depois de reiniciar o Claude Code, as 5 tools aparecem no autocomplete e podem ser chamadas em conversas.

## Compliance

O server enforça a SAP API Policy Q33 via `assertCompliance(category, ctx)` antes de cada tool. Tools dessa categoria já listadas são **endorsed**. Para adicionar tools em zona cinza no futuro, será necessário:

1. Declarar `category: 'business-data-read' | 'sql-execute' | 'business-runtime'`
2. Usuário setar `CAPITU_COMPLIANCE_MODE=permissive` **E** `CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes`

Caso contrário a tool retorna `CompliancePolicyViolation` para o LLM.
