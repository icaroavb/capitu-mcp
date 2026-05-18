# capitu-output/

Pasta padrão onde o **capitu-mcp** despeja arquivos gerados (`.docx`, `.md`) para você revisar/compartilhar.

> ⚠️ **O conteúdo desta pasta é gitignored.** Apenas este README e a estrutura de subpastas (via `.gitkeep`) vão pro repositório. Documentos gerados ficam **localmente** no seu workspace — não vazam pro git acidentalmente.

## Estrutura

```
capitu-output/
├── documentation/      ← Documentação técnica de objetos ABAP/CDS
├── specifications/     ← Especificações funcionais/técnicas (specs)
└── analysis/           ← Análises ad-hoc, where-used, impact, comparativos
```

Cada subpasta é criada conforme as tools do capitu vão escrevendo. Os arquivos seguem o padrão:

```
YYYY-MM-DD_HHmm_<titulo-slug>.<ext>
```

Por exemplo: `2026-05-14_1942_zi_test_capitu_documentacao_tecnica.docx`.

## Como o capitu escreve aqui

| Tool MCP | O que escreve | Onde |
|----------|---------------|------|
| `capituSpecExportDocx` | Conteúdo markdown qualquer → docx ou md | qualquer categoria que você escolher |
| `capituSpecExportProposalDocx` | Proposta de spec (por token) → docx | `specifications/` |
| `capituSpecListOutputs` | Lista o que já existe (read-only) | — |
| `capituDevDocumentObject` | Lê objeto ABAP via ADT + monta doc técnico | `documentation/` |

## Mudar o local da pasta

Por padrão é `<projeto>/capitu-output/`. Para apontar para outro lugar (ex: OneDrive separado, drive de equipe):

```powershell
[Environment]::SetEnvironmentVariable("CAPITU_OUTPUT_DIR", "<caminho-absoluto-da-pasta>", "User")
```

Depois reabra o Claude Code para o servidor MCP herdar a variável.

## Limpeza

A pasta cresce com o uso. Como tudo está gitignored, fique à vontade para apagar arquivos antigos manualmente, ou criar um job que limpe arquivos com mais de N dias.
