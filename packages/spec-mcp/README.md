# @capitu/spec-mcp

Terceiro MCP do ecossistema capitu. Foco: **traduzir requisitos em especificações técnicas SAP** (RAP/CDS/services), ancoradas na realidade do tenant via where-used e validação contra ADT.

## Tools expostas

| Tool | Categoria | Descrição |
|------|-----------|-----------|
| `capituSpecDraft` | docs-read | Recebe requisito + lista de artifacts, devolve spec em markdown estruturado |
| `capituSpecValidate` | metadata-read | Checa spec contra tenant real: pacote existe? nomes colidem? referências válidas? |
| `capituSpecImpactAnalysis` | code-read | Where-used de um objeto, classifica risco (isolated / low / medium / high) |
| `capituSpecLearn` | docs-read | Grava decisão/padrão arquitetural no KB compartilhado |
| `capituSpecRecallLearnings` | docs-read | Busca learnings (de spec, dev OU docs) por similaridade |

Todas categorias **endorsed** sob a SAP API Policy Q33 — funcionam em `strict` mode sem opt-in.

## Como capitu-spec se encaixa no ecossistema

```
┌──────────┐ requirement   ┌──────────┐ structured  ┌──────────┐ create+write
│ usuário  │ ─────────────►│  spec    │ ──────────► │  dev     │ ──────────► SAP
└──────────┘               └────┬─────┘             └────┬─────┘
                                │ consulta              │ consulta
                                ▼                       ▼
                            ┌──────────────────────────────┐
                            │  KB compartilhada (SQLite)   │
                            │  - learnings de todos        │
                            │  - tenant catalog            │
                            └──────────────────────────────┘
                                ▲
                                │ alimenta docs
                            ┌──────────┐
                            │  docs    │
                            └──────────┘
```

## Fluxo típico

```
1. Você: "Quero relatório de voos por companhia"
2. Claude (você) analisa e chama capituSpecDraft com:
   - title, requirement, approach (curto)
   - artifacts: [{kind:'cds-interface', name:'ZI_FLIGHTS_BY_CARRIER', basedOn:'/dmo/flight'}, ...]
3. capituSpecDraft devolve markdown com:
   - tabela de artifacts
   - considerations (transport, autorização, data-quality)
   - implementation steps em ordem RAP-correta
   - hints de capituDev* calls
4. Você opcionalmente roda capituSpecValidate antes de implementar
5. capituDev* executa cada step
```

## Variáveis de ambiente

Mesmas do docs-mcp e dev-mcp:

- `SAP_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_LANGUAGE`
- `CAPITU_KB_PATH`, `CAPITU_COMPLIANCE_MODE`, `CAPITU_EMBEDDINGS`, `VOYAGE_API_KEY`

Nenhuma flag específica — capitu-spec não escreve no SAP, então não precisa de `CAPITU_ALLOW_WRITES`.

## Diferenciação

Nenhum dos ~10 concorrentes MCP SAP de 2026 (ARC-1, vsp, mcp-sap-docs, etc.) tem agente especializado em **specification authoring com validação contra tenant**. É o gap mais conceitual e o mais valioso pro fluxo de trabalho real de ABAP devs.
