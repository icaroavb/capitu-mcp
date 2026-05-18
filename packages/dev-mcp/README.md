# @capitu/dev-mcp

Segundo MCP do ecossistema capitu. Expõe **desenvolvimento ABAP via ADT**: leitura, busca, where-used, syntax check, escrita e ativação. Tudo dentro do escopo endossado da SAP API Policy Q33.

## Tools expostas

### Read (sempre permitido em strict mode)

| Tool | Categoria | Descrição |
|------|-----------|-----------|
| `capituDevReadObject` | code-read | Lê fonte de qualquer objeto ABAP/CDS por URI |
| `capituDevReadPackage` | metadata-read | Lista conteúdo de um pacote (Eclipse-style) |
| `capituDevSearch` | code-read | Busca objetos por padrão/tipo (TADIR) |
| `capituDevFindReferences` | code-read | Where-used: quem usa esse objeto/símbolo |

### Check + Write (gated por opt-in)

| Tool | Categoria | Descrição |
|------|-----------|-----------|
| `capituDevSyntaxCheck` | code-check | Roda syntax check ABAP/CDS (sem ativar) |
| `capituDevWriteObject` | code-write | Escreve fonte (lock → check → write → unlock) |
| `capituDevActivate` | code-write | Ativa objeto inativo |

### Learnings (KB compartilhado com capitu-docs)

| Tool | Categoria | Descrição |
|------|-----------|-----------|
| `capituDevLearn` | docs-read | Grava aprendizado no KB compartilhado |
| `capituDevRecallLearnings` | docs-read | Recupera aprendizados (de docs E dev) por similaridade |

## Safety: writes off-by-default

Escritas exigem **dois opt-ins**:

1. `CAPITU_ALLOW_WRITES=true` — habilita o grupo de write
2. `CAPITU_ALLOWED_PACKAGES=$TMP,Z*` — quais pacotes podem ser escritos

Sem esses, qualquer chamada de write/activate retorna erro semântico antes de tocar no SAP.

A categoria compliance (Q33) já permite essas tools como "developer tooling endossado" — o opt-in é uma camada adicional contra acidentes.

## Variáveis de ambiente

| Var | Obrigatório | Descrição |
|-----|------------|-----------|
| `SAP_URL` | sim | URL ADT do tenant |
| `SAP_USER` | sim | Usuário ADT |
| `SAP_PASSWORD` | sim | Senha (idealmente persistente no Windows User scope) |
| `SAP_CLIENT` | não | Mandant |
| `CAPITU_KB_PATH` | não | KB compartilhada (mesma de docs-mcp) |
| `CAPITU_COMPLIANCE_MODE` | não | `strict` (default) ou `permissive` |
| `CAPITU_ALLOW_WRITES` | não | `true` para liberar writes |
| `CAPITU_ALLOWED_PACKAGES` | não | CSV de pacotes/wildcards. Default: `$TMP` |
| `CAPITU_EMBEDDINGS` | não | `voyage` (recomendado) ou `local` |
| `VOYAGE_API_KEY` | só se voyage | Chave Voyage AI |

## Aprendizado cross-agent

Esta é a feature mais distintiva. Quando `capitu-dev` resolve um problema (ex: ED064 quirk, package conflict), grava em `learnings` com `sourceAgent='capitu-dev'`. Quando `capitu-docs` busca learnings, vê os do dev também. Vice-versa.

A KB é **uma só**, indexada por vetor (Voyage 512 dims). Cresce com o uso. É o que nenhum dos ~10 concorrentes MCP SAP faz.
